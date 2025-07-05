import * as fs from 'fs/promises';
import * as path from 'path';
import fg from 'fast-glob';

export class FileScanner {
  async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async isDirectory(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(filePath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  async getFilesList(directoryPath: string): Promise<string[]> {
    if (!(await this.pathExists(directoryPath))) {
      throw new Error(`No such file or directory: ${directoryPath}`);
    }

    if (!(await this.isDirectory(directoryPath))) {
      throw new Error(`Path is not a directory: ${directoryPath}`);
    }

    const absolutePath = path.resolve(directoryPath);

    const allPaths = await fg('*', {
      cwd: absolutePath,
      absolute: true,
      dot: true,
      onlyFiles: true,
    });

    return allPaths;
  }
}
