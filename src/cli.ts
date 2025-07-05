import { Command } from 'commander';
import { FileScanner } from './scanner';
import * as path from 'path';

const program = new Command();

program
  .name('walrus-sync')
  .description('Rsync-like tool for Walrus decentralized store')
  .version('0.0.1')
  .argument('<src>', 'file or directory to sync')
  .option(
    '--dry-run',
    'show files that would be synced with Walrus without uploading them',
    false,
  )
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
    }
  });

program.parse();
