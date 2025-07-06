# walrus-sync

A CLI for uploading a single file or a directory to [Walrus](https://www.walrus.xyz/). The CLI tracks the upload state locally to resume the upload when the upload was not completed.

## Usage

To run CLI you need to set the `SUI_PRIVATE_KEY` env variable.
You can run `cp .env.example .env` and set the `SUI_PRIVATE_KEY`.

The private key should have access to an account that has sufficient `SUI` and sufficient `WAL` ([read more](https://sdk.mystenlabs.com/walrus#writing-blobs)).

To test locally you need to:

```bash
npm run build
npm link
```

Then you can run:

```bash
walrus-sync --help
Usage: walrus-sync [options] <src>

Rsync-like tool for Walrus decentralized store

Arguments:
  src                File or directory to sync

Options:
  -V, --version      output the version number
  --dry-run          Show files that would be synced with Walrus without uploading them (default: false)
  --epochs <epochs>  The number of epochs to store the blob(s) for.
  --deletable        Mark the blob as deletable (default: false)
  --resume           Resume the incomplete uploads from a directory (default: false)
  -h, --help         display help for command
```

To upload a file or a directory of files:

```bash
walrus-sync FILE_OR_DIR --epochs EPOCHS
```

### Current Limitations

The current repo is a proof-of-concept so there are many limitations and edge cases that have not been tested/explored:

- Need to validate the exact behavior of the [Rust-based `walrus` CLI](https://github.com/MystenLabs/walrus/tree/main/crates/walrus-service/src) when the same file is uploaded with a different `--epochs` parameter and adjust the `walrus-sync` CLI accordingly to have the same behavior.
- The CLI does not currently handle different options when an upload is stopped and it's resumed with different options.
- Currently the repo supports only `Ed25519` privaate keys. It's not difficult to extend to the other keypair schemes.
- The CLI has extensive logging for debugging purposes. The logging needs to be cleaned up or rephrased.

### Future Improvements

The current implementation can upload files from a directory. Some:

- Currently all the file-blobs are uploaded from depth 1 of a directory. Need to add functionality to upload files from subdirectories of a directory.
- To upload a whole directory, a more appropriate approach would be to have a file that tracks the structure of the subdirectories so, on retrieval the whole directory with the correct structure can be recreated.