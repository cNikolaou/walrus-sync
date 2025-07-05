import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { WalrusClient } from '@mysten/walrus';
import * as fs from 'fs/promises';
import * as path from 'path';

type NetworkOptions = 'mainnet' | 'testnet';

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
      `Using wallet address: ${this.signer.getPublicKey().toSuiAddress()}`,
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

  async uploadFile(filePath: string, epochs: number, deletable?: boolean) {
    if (!epochs) {
      throw new Error('Should specify the number for `epochs`');
    }

    try {
      const fileContent = await fs.readFile(filePath);
      const fileName = path.basename(filePath);
      const blobId = await this.calculateBlobId(fileContent);
      const exists = await this.blobExists(blobId);

      // Avoid re-uploading a blob that exist on Walrus
      if (exists) {
        console.log(
          `Skipping: ${fileName} already exists with blob ID: ${blobId}`,
        );
        return;
      }

      // Follow the default behavior of the walrus Rust CLI: blobs should not
      // be deletable, unless the user has specified that by the CLI args
      deletable = deletable || false;

      console.log(
        `Uploading: ${path.basename(filePath)} (${
          fileContent.length
        } bytes) for ${epochs} (deletable: ${deletable}) - BlobId: ${blobId}`,
      );

      const result = await this.walrusClient.writeBlob({
        blob: fileContent,
        deletable: deletable,
        epochs: epochs,
        signer: this.signer,
      });

      console.log(`Uploading: ${fileName} (${fileContent.length} bytes)`);
      console.log(result);
    } catch (error) {
      console.error(`Failed to upload: ${path.basename(filePath)}:`, error);
    }
  }
}
