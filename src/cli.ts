import 'dotenv/config';
import { Command } from 'commander';
import * as path from 'path';

import { FileScanner } from './scanner';
import { WalrusUploader } from './uploader';

const program = new Command();

program
  .name('walrus-sync')
  .description('Rsync-like tool for Walrus decentralized store')
  .version('0.0.1')
  .argument('<src>', 'File or directory to sync')
  .option(
    '--dry-run',
    'Show files that would be synced with Walrus without uploading them',
    false,
  )
  .requiredOption(
    '--epochs <epochs>',
    'The number of epochs to store the blob(s) for.',
  )
  .option('--deletable', 'Mark the blob as deletable', false)
  .action(async (src: string, options) => {
    const scanner = new FileScanner();
    if (!src || !(await scanner.pathExists(src))) {
      console.log('Error: Please specify a source file or directory');
      console.log('\nUsage examples:');
      console.log('  walrus-sync my-folder --dry-run');
      console.log('  walrus-sync document.pdf');
      process.exit(1);
    }

    let filesList: string[] = [];

    if (await scanner.isDirectory(src)) {
      console.log(`Syncing files from directory: ${src}`);
      filesList = await scanner.getFilesList(src);
    } else {
      console.log(`Syncing file: ${src}`);
      filesList = [path.resolve(src)];
    }

    if (options.dryRun) {
      console.log(
        'Dry-run operation; the follow file(s) will not be uploaded to Walrus',
      );
      for (const fp of filesList) {
        console.log(`\t${fp}`);
      }
    } else {
      console.log('Storing in Walrus:');

      const walrusUploader = new WalrusUploader('mainnet');
      walrusUploader.uploadFiles(filesList, {
        epochs: options.epochs,
        deletable: options.deletable,
      });
    }
  });

program.parse();
