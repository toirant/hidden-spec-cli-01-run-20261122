# mend

One patch tool for every AI edit format.

`mend` applies an edit that an AI model wrote to a tree of text files.
Models write edits in four formats, and `mend` reads all four to one
written contract (`SPEC.md`): a unified diff (often with wrong line
numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor
tool calls as JSON. It finds the lines an edit names even when the model
drifted their whitespace or indentation, and it changes every file or
none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch
  is relative to it.
- `PATCH` is the path of the patch file. When it is absent or is `-`,
  the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code
  as without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Exit codes and output

- Exit 2, one line: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.
- Exit 1: one `error: <code> <path>` line for each edit that failed
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), in the
  patch's order, then `failed: <k> of <n> edits`. When any edit failed,
  no file is written.
- Exit 0: one line for each path whose state changed (`A`, `D`, `M`,
  or `R <old> -> <new>` for a move), in byte order of the paths, then
  `ok: <n> file(s)`.

## Matching

An edit's old lines are found at the first of three tiers at which
they occur: exact, trailing whitespace ignored, then leading and
trailing whitespace ignored. At the third tier, new lines are
re-indented to the file's own indentation. Unified hunks take the
occurrence nearest the (possibly wrong) line number in the patch;
SEARCH/REPLACE fails as ambiguous when the old lines occur more than
once; V4A chunks search forward from a cursor, optionally anchored.

## Line breaks

A changed file keeps its own line break (CRLF or LF) and its final
line break, unless a unified hunk says otherwise
(`\ No newline at end of file`). A file an edit creates is written
with LF breaks. CRLF files are handled throughout, including JSON
`str_replace`, which normalises `\r\n` before matching and restores it
afterwards.

## Checking locally

The kit's practice set (100 checks) runs with the checker beside
`main.ts`:

```
node check.ts /path/to/program/generator/practice.json
```

Local grade on the public practice set: **100/100, practice score 1000**.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone.
- `runner.ts` — the kit's trial runner, kept as shipped.
- `check.ts` — the kit's practice-set checker, kept as shipped.
- `SPEC.md` — the whole specification.
- `LICENSE` — MIT.

## Licence

MIT. See `LICENSE`.
