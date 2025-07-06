import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { WalrusClient } from '@mysten/walrus';
import * as fs from 'fs/promises';
import * as path from 'path';

import { StateManager, type UploadState } from './state';
import { uint8ArrayToBase64 } from './utils';

type NetworkOptions = 'mainnet' | 'testnet';

type UploadOptions = {
  epochs: number;
  deletable: boolean | undefined;
};

export class WalrusUploader {
  private walrusClient: WalrusClient;
  private signer: Ed25519Keypair;
  private stateManager: StateManager;

  constructor(network: NetworkOptions) {
    const privateKey = process.env.SUI_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error(
        'SUI_PRIVATE_KEY environment variable is required.\n' +
          'Set it with: export SUI_PRIVATE_KEY="your-private-key"',
      );
    }

    try {
      this.signer = Ed25519Keypair.fromSecretKey(privateKey);
    } catch (error) {
      throw new Error(
        "Invalid SUI_PRIVATE_KEY format. Make sure it's a valid base64 private key.",
      );
    }

    const suiClient = new SuiClient({
      url: getFullnodeUrl(network),
    });

    this.walrusClient = new WalrusClient({
      network: network,
      suiClient,
    });

    this.stateManager = new StateManager();

    console.log(
      `> Uploading using wallet address: ${this.signer
        .getPublicKey()
        .toSuiAddress()}`,
    );
  }

  async blobExists(blobId: string): Promise<boolean> {
    try {
      await this.walrusClient.readBlob({ blobId });
      return true;
    } catch (error) {
      return false;
    }
  }

  async calculateBlobId(content: Uint8Array): Promise<string> {
    const metadata = await this.walrusClient.computeBlobMetadata({
      bytes: content,
    });
    return metadata.blobId;
  }

  /**
   * Follow the pattern used by the WalrusClient.writeBlob() function to upload
   * a file to Walrus and described at:
   *  https://github.com/MystenLabs/walrus/blob/main/docs/book/design/operations-off-chain.md
   *
   * @param filePath Path of the file to-be-uploaded.
   * @param options
   */
  async uploadFile(filePath: string, options: UploadOptions) {
    if (!options.epochs) {
      throw new Error('Should specify the number for `epochs`');
    }

    try {
      // TODO: should check the file exists before trying to read
      const fileContent = await fs.readFile(filePath);
      const fileName = path.basename(filePath);
      const blobId = await this.calculateBlobId(fileContent);

      // load the tracked state for the current upload
      let state = await this.stateManager.loadState(blobId);

      if (!state) {
        const isCertified = await this.isBlobCertified(blobId);

        // The blob is uploaded and certified; skip
        if (isCertified) {
          console.log(
            `Skipping: ${fileName} already uploaded with blob ID: ${blobId}`,
          );
          return;
        }

        // No state for current file stored locally and no file found on Walrus;
        // initialize a new state before starting the upload.
        state = {
          filePath,
          blobId,
          stage: 'encoding',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      } else {
        console.log(
          `Found existing state: stage=${state.stage}, objectId=${state.blobObjectId}`,
        );

        // If state shows completed check certification
        if (state.stage === 'completed') {
          // Avoid re-uploading a blob that exist on Walrus
          const isCertified = await this.isBlobCertified(blobId);
          if (isCertified) {
            console.log(
              `Upload already completed and certified for ${fileName}`,
            );
            await this.stateManager.removeState(blobId);
            return;
          } else {
            console.log(
              'State shows completed but blob not certified, restarting upload',
            );
            state.stage = 'encoding';
          }
        }

        console.log('Resuming from stage:', state.stage);
      }

      // Follow the default behavior of the walrus Rust CLI: blobs should not
      // be deletable, unless the user has specified that by the CLI args
      const deletable = options.deletable || false;

      options.deletable = deletable;

      console.log(
        `Uploading: ${path.basename(filePath)} (${
          fileContent.length
        } bytes) [epoch: ${
          options.epochs
        } epochs, deletable: ${deletable}] - BlobId: ${blobId}`,
      );

      // execute the from the appropriate stage
      await this.executeStage(state, fileContent, options);

      console.log(`Uploading: ${fileName} (${fileContent.length} bytes)`);
    } catch (error) {
      console.error(`Failed to upload: ${path.basename(filePath)}:`, error);
    }
  }

  async uploadFiles(filePaths: string[], options: UploadOptions) {
    for (const fp of filePaths) {
      await this.uploadFile(fp, options);
    }
  }

  /**
   * Execute the appropriate upload stage based on the provided `state`.
   *
   * @param state object that stores the state of a file's upload
   * @param fileContent byte array of the file's content
   * @param options upload options
   * @returns
   */
  private async executeStage(
    state: UploadState,
    fileContent: Uint8Array,
    options: UploadOptions,
  ) {
    try {
      switch (state.stage) {
        case 'encoding':
          await this.stageEncoding(state, fileContent, options);
          break;
        case 'registered':
          await this.stageUploading(state, fileContent, options);
          break;
        case 'uploading':
          await this.stageCertifying(state, options);
          break;
        case 'certifying':
          await this.stageCertifying(state, options);
          break;
        case 'completed':
          console.log(
            `Upload already completed for ${path.basename(state.filePath)}`,
          );
          return;
        case 'failed':
          console.log(
            `Retrying failed upload for ${path.basename(state.filePath)}`,
          );
          await this.stageEncoding(state, fileContent, options);
          break;
      }
    } catch (error) {
      state.stage = 'failed';

      let errorMessage: string;
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      } else if (error && typeof error === 'object') {
        errorMessage = JSON.stringify(error);
      } else {
        errorMessage = 'An unknown error occurred';
      }

      state.error = errorMessage;
      state.updatedAt = new Date().toISOString();

      await this.stateManager.saveState(state);
      throw error;
    }
  }

  /**
   * First upload stage: encode and create Sui object.
   */
  private async stageEncoding(
    state: UploadState,
    fileContent: Uint8Array,
    options: UploadOptions,
  ) {
    console.log('Stage 1/3: Encoding and registering blob...');

    const encoded = await this.walrusClient.encodeBlob(fileContent);
    const { sliversByNode, metadata, rootHash } = encoded;

    // create Sui object that tracks the Walrus blob
    const suiBlobObject =
      await this.walrusClient.executeRegisterBlobTransaction({
        signer: this.signer,
        size: fileContent.length,
        epochs: options.epochs,
        blobId: encoded.blobId,
        rootHash: rootHash,
        deletable: options.deletable || false,
        owner: this.signer.toSuiAddress(),
      });

    // update the file's upload state
    state.metadata = metadata;
    state.blobObjectId = suiBlobObject.blob.id.id;
    state.rootHash = uint8ArrayToBase64(rootHash);
    state.sliversByNode = sliversByNode;
    state.stage = 'registered';

    await this.stateManager.saveState(state);

    console.log(
      `Blob registered on Sui with object ID: ${suiBlobObject.blob.id.id}`,
    );

    // move to next upload stage
    await this.stageUploading(state, fileContent, options);
  }

  /**
   * Second upload stage: upload the slivers to nodes.
   *
   * NOTE: Currently there are some errors to be investigated when the
   * upload resumes from this stage. If those errors appear we start
   * the upload from the previous stage.
   */
  private async stageUploading(
    state: UploadState,
    fileContent: Uint8Array,
    options: UploadOptions,
  ) {
    console.log('Stage 2/3: Uploading to storage nodes...');

    if (!state.metadata || !state.sliversByNode || !state.blobObjectId) {
      throw new Error('Missing required state for uploading stage');
    }

    try {
      const confirmations = await this.walrusClient.writeEncodedBlobToNodes({
        blobId: state.blobId,
        metadata: state.metadata,
        sliversByNode: state.sliversByNode,
        deletable: options.deletable || false,
        objectId: state.blobObjectId,
      });

      // Calculate the valid confirmations out of all the confirmations
      const validConfirmations = confirmations.filter((c) => c !== null);

      console.log(
        `Uploaded to storage nodes, got ${validConfirmations.length}/${confirmations.length} confirmations`,
      );

      // Continue only if we have valid confirmations
      if (validConfirmations.length === 0) {
        throw new Error('No valid confirmations received from storage nodes');
      }

      // Update state
      state.confirmations = confirmations;
      state.stage = 'uploading';

      await this.stateManager.saveState(state);

      // Continue to certification
      await this.stageCertifying(state, options);
    } catch (error) {
      console.error('Upload to storage nodes failed:', error);

      // Resuming an upload on stage 2 returns and error. Need to investigate
      // further why that happens.
      console.log(
        'Stage 2 failed, restarting from encoding (will delete Sui object and create new one)',
      );

      // cleanup
      if (state.blobObjectId) {
        try {
          console.log('Cleaning up failed blob object:', state.blobObjectId);
          await this.walrusClient.executeDeleteBlobTransaction({
            blobObjectId: state.blobObjectId,
            signer: this.signer,
          });
          console.log('Cleaned up failed blob object');
        } catch (cleanupError) {
          console.warn('Could not clean up blob object:', cleanupError);
        }
      }

      // Reset to encoding stage and clear problematic data
      state.stage = 'encoding';
      state.blobObjectId = undefined;
      state.metadata = undefined;
      state.sliversByNode = undefined;
      state.confirmations = undefined;
      state.error = undefined;

      await this.stateManager.saveState(state);

      // Restart from encoding
      console.log('Restarting upload from stage 1...');
      await this.executeStage(state, fileContent, options);
    }
  }

  /**
   * Third upload stage: certify upload. In case of failure during this
   * stage the blobs might be certified but the local state might not be
   * up-to-date so check if the blob is certified with `isBlobCertified()`.
   */
  private async stageCertifying(state: UploadState, options: UploadOptions) {
    console.log('Stage 3/3: Certifying blob...');

    if (!state.confirmations || !state.blobObjectId) {
      throw new Error('Missing required state for certification stage');
    }

    try {
      // The blob might be certified even though the local state does
      // not reflect that yet.
      const isCertified = await this.isBlobCertified(state.blobId);

      if (isCertified) {
        console.log('Blob is already certified! Skipping certification step.');
        await this.stateManager.removeState(state.blobId);
        return;
      }

      // Certify blob
      await this.walrusClient.executeCertifyBlobTransaction({
        signer: this.signer,
        blobId: state.blobId,
        blobObjectId: state.blobObjectId,
        confirmations: state.confirmations,
        deletable: options.deletable || false,
      });

      // Update state
      state.stage = 'completed';
      await this.stateManager.saveState(state);

      console.log(
        'Blob certified successfully for: ',
        path.basename(state.filePath),
      );

      await this.stateManager.removeState(state.blobId);
    } catch (error) {
      console.error('Error:', error);
      state.stage = 'failed';
      await this.stateManager.saveState(state);
    }
  }

  /**
   * Validate if a blob exists and it's stored in Walrus and certified.
   * Currently the logic is a bit complicated and should be simplified.
   *
   * @param blobId the ID of the blob for a file which might be uploaded on Walrus
   * @returns true if the blob is stored in Walrus and it's certified
   */
  async isBlobCertified(blobId: string): Promise<boolean> {
    try {
      // check the status if the blob exists
      const status = await this.walrusClient.getVerifiedBlobStatus({ blobId });

      // if 'permanent' or 'deletable' then check the confirmation epoch else
      // it's not confirmed
      if (status.type === 'permanent' || status.type === 'deletable') {
        return status.initialCertifiedEpoch !== null;
      }
      return false;
    } catch (error) {
      // if there is no status then check if the blob exists at all, if not
      // then the blob is definitely not certified
      try {
        await this.walrusClient.readBlob({ blobId });
        return true;
      } catch (readError) {
        return false;
      }
    }
  }
}
