# Vendored tree-sitter grammars

Copied unchanged from the npm packages, whose install scripts build native bindings we don't need:

| File | From | sha256 |
|---|---|---|
| `tree-sitter-typescript.wasm` | `tree-sitter-typescript@0.23.2` | `778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d` |
| `tree-sitter-tsx.wasm` | `tree-sitter-typescript@0.23.2` | `79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8` |
| `tree-sitter-javascript.wasm` | `tree-sitter-javascript@0.25.0` | `5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240` |

Both are MIT licensed, copyright (c) 2014 and 2017 Max Brunsfeld. The parser's core (`web-tree-sitter.wasm`) is
imported from the `web-tree-sitter` package instead, so it always matches its JavaScript.

Grammars and `web-tree-sitter` (pinned at 0.27.1) move together: a prebuilt grammar must use the format that version
expects. After changing either, run `npm run test:workerd`.
