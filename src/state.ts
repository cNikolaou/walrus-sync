import * as fs from 'fs/promises';
import * as path from 'path';

export type UploadStage =
  | 'encoding'
  | 'registered'
  | 'uploading'
  | 'certifying'
  | 'completed'
  | 'failed';

export type UploadState = {
  blobId: string;
  filePath: string;
  stage: UploadStage;
  blobObjectId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: any;
  confirmations?: any[];
  rootHash?: string;
  sliversByNode?: any[];
  error?: string;
};

export class StateManager {
  private stateDir: string;

  constructor(stateDir = '.walrus-upload-state') {
    this.stateDir = stateDir;
  }

  /**
   * Create the (hidden) subdirectory that keeps all the state-files, each of
   * which keeps tracks of the upload state for a file
   */
  async ensureStateDir() {
    await fs.mkdir(this.stateDir, { recursive: true });
  }

  /**
   * Get the path of a specific state-file.
   *
   * @param blobId the ID of the blob for a file which is/will be uploaded on Walrus
   * @returns the path for of the state-file for a specific file
   */
  private getStateFilePath(blobId: string): string {
    return path.join(this.stateDir, `${blobId}.json`);
  }

  /**
   * Save the `state` to a state-file. Overwrites previously stored state
   * without any checks. Should add checks as the overwriting is not safe.
   *
   * @param state The state to be stored in the state-file.
   */
  async saveState(state: UploadState) {
    await this.ensureStateDir();
    state.updatedAt = new Date().toISOString();
    const filePath = this.getStateFilePath(state.blobId);
    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
  }

  /**
   * Read the state stored in a state-file. Returns null if the statefile does
   * not exist (or any other error is thrown).
   *
   * @param blobId the ID of the blob for a file which is/will be uploaded on Walrus
   */
  async loadState(blobId: string): Promise<UploadState | null> {
    try {
      const filePath = this.getStateFilePath(blobId);
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  /**
   * Remove the stored state-file.
   *
   * @param blobId the ID of the blob for a file which is/will be uploaded on Walrus
   */
  async removeState(blobId: string) {
    const filePath = this.getStateFilePath(blobId);
    await fs.unlink(filePath);
  }
}
