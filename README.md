# repo2md (v0.2.0)

A small Node.js CLI that flattens a Git repository into a single Markdown file.

It writes each tracked text file into one output document, with optional repository tree listing and token count summary.

## Quick Start

```bash
# 1) From the repository root
cd <path-to-repo2md>

# 2) Create a flattened file (defaults to repo2md_flattened.md)
node repo2md.mjs

# 3) Create a flattened file with a custom name
node repo2md.mjs flattened.md

# 4) Create a smaller flattened file without tree section
node repo2md.mjs flattened-no-tree.md --no-tree

# 5) Flatten a specific revision
node repo2md.mjs flattened-head.md --rev HEAD --no-tree

# 6) Flatten only the src directory
node repo2md.mjs --root src
```

## Requirements

- Node.js 18+
- Git installed and available on PATH
- Run inside a Git repository

## Usage

```bash
node repo2md.mjs [output.md] [--encoding <enc>] [--max-tokens <n>] [--rev <rev>] [--root <dir>] [--no-tree]
                 [--include <pattern>] [--exclude <pattern>]
node repo2md.mjs --help
```

## Examples

```bash
node repo2md.mjs                                          # Creates <reponame>_flattened.md
node repo2md.mjs custom.md                                 # Creates custom.md
node repo2md.mjs --encoding o200k_base                     # Specific token encoding
node repo2md.mjs --max-tokens 128000                       # With token limit
node repo2md.mjs --rev HEAD                                # Flatten at specific revision
node repo2md.mjs --root src                                # Flatten only the src directory
node repo2md.mjs --include '**/*.js' --include '**/*.ts'   # Only JS/TS files
node repo2md.mjs --exclude 'tests/**' --exclude '*.md'     # Exclude tests and markdown
node repo2md.mjs --no-tree                                 # Skip repository tree section
```

## Options

- `output.md`
  - Optional output file path.
  - Default: `<reponame>_flattened.md`.
- `--encoding <enc>`
  - Token encoding name used for token counting.
  - Default: `o200k_base` (or `ENCODING` env var).
- `--max-tokens <n>`
  - Optional upper limit for token count.
  - If output exceeds the limit, script exits with code `2` and appends a warning in the output file.
  - Default: `0` (disabled) (or `MAX_TOKENS` env var).
- `--rev <rev>`
  - Flatten files from a Git revision (for example `HEAD`, branch name, commit SHA).
  - If omitted, uses current working tree tracked files.
- `--root <dir>`
  - Flatten only a specific subdirectory of the repository.
  - Default: `.` (entire repository).
- `--no-tree`
  - Skip the `## Repository Tree` section at the top of the output.
- `--include <pattern>`
  - Glob pattern to include only matching files (repeatable).
  - Supports `*`, `?`, `**`, `{a,b}`, `[abc]`.
  - If not specified, all tracked files are included.
- `--exclude <pattern>`
  - Glob pattern to exclude matching files (repeatable).
  - Supports the same glob syntax as `--include`.
- `-h`, `--help`
  - Print usage and examples.

## Tests

This project includes:

- Unit tests for argument parsing and helper functions.
- Functional tests that run the CLI against a temporary Git repository.

Run tests:

```bash
npm test
```

The `package.json` test script runs:

```bash
node --test tests/*.test.mjs
```

## What Gets Included

- Tracked files from Git:
  - Working tree mode: `git ls-files -z`
  - Revision mode: `git ls-tree -r --name-only -z <rev>`
- Text files only:
  - Binary files are skipped (NUL-byte check on first 8 KB).
  - Image files are always excluded (png, jpg, gif, svg, webp, etc.).
- Filtered by `--include` / `--exclude` glob patterns when specified.

## Output Format

The generated file contains:

1. Header metadata
2. Optional `## Repository Tree` listing
3. A section per text file:
   - `## \`path/to/file\``
   - fenced code block with language based on file extension
4. Token count summary:
   - token total
   - counting method
   - encoding

If `--max-tokens` is set and exceeded, an extra warning line is appended.

## Token Counting

The script tries these packages at runtime:

- `@dqbd/tiktoken`
- `@dbdq/tiktoken`

If neither is available, it falls back to an approximation:

- `approx(chars/4)`

## Exit Codes

- `0`: success
- `1`: unexpected runtime error
- `2`: usage error or token limit exceeded

## Notes

- The script reads file content as UTF-8 when flattening working tree files.
- The script automatically chooses a safe Markdown fence length so embedded backticks in file content do not break code blocks.
