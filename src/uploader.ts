import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { WalrusClient } from '@mysten/walrus';
import * as fs from 'fs/promises';
import * as path from 'path';

type UploadStage =
  | 'encoding'
  | 'registered'
  | 'uploading'
  | 'certifying'
  | 'completed'
  | 'failed';

type UploadState = {
  blobId: string;
  filePath: string;
  stage: UploadStage;
  blobObjectId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: any;
  confirmations?: any[];
  rootHash?: any;
  sliversByNode?: any[];
};

type NetworkOptions = 'mainnet' | 'testnet';

type UploadOptions = {
  epochs: number;
  deletable: boolean | undefined;
};

export class WalrusUploader {
  private walrusClient: WalrusClient;
  private signer: Ed25519Keypair;

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

      // track the state of the current upload
      let state = {
        filePath: filePath,
        blobId: blobId,
        stage: 'encoding' as UploadStage,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const exists = await this.blobExists(blobId);

      // Avoid re-uploading a blob that exist on Walrus
      if (exists) {
        console.log(
          `Skipping: ${fileName} already uploaded with blob ID: ${blobId}`,
        );
        return;
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

      await this.stageEncoding(state, fileContent, options);

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

  private async stageEncoding(
    state: UploadState,
    fileContent: Uint8Array,
    options: UploadOptions,
  ) {
    console.log('Stage 1/3: Encoding and registering blob...');

    const encoded = await this.walrusClient.encodeBlob(fileContent);
    const { sliversByNode, metadata, rootHash } = encoded;

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

    // update state
    state.metadata = metadata;
    state.blobObjectId = suiBlobObject.blob.id.id;
    state.rootHash = rootHash;
    state.sliversByNode = sliversByNode;
    state.stage = 'registered';

    console.log(
      `Blob registered on Sui with object ID: ${suiBlobObject.blob.id.id}`,
    );

    await this.stageUploading(state, fileContent, options);
  }

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

      state.confirmations = confirmations;
      state.stage = 'uploading';

      const validConfirmations = confirmations.filter((c) => c !== null);

      console.log(
        `Uploaded to storage nodes, got ${validConfirmations.length}/${confirmations.length} confirmations`,
      );

      // Continue only if we have valid confirmations
      if (validConfirmations.length === 0) {
        throw new Error('No valid confirmations received from storage nodes');
      }

      // Continue to certification
      await this.stageCertifying(state, options);
    } catch (error) {
      console.error('Upload to storage nodes failed:', error);
      state.stage = 'failed';
      throw error;
    }
  }

  private async stageCertifying(state: UploadState, options: UploadOptions) {
    console.log('Stage 3/3: Certifying blob...');

    if (!state.confirmations || !state.blobObjectId) {
      throw new Error('Missing required state for certification stage');
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

    console.log(
      'Blob certified successfully for: ',
      path.basename(state.filePath),
    );
  }
}
