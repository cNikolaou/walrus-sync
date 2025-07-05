import { Command } from 'commander';
import { FileScanner } from './scanner';

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

    const isDirectory = await scanner.isDirectory(src);

    if (isDirectory) {
      console.log(`Syncing files from directory: ${src}`);
    } else {
      console.log(`Syncing file: ${src}`);
    }
  });

program.parse();
