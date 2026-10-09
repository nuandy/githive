// Edit: an .editorconfig that states the style the code already uses (2 spaces, LF, final newline).
// Usage: node editorconfig.mjs <repo>
import { writeFileSync } from "node:fs";
const [repo] = process.argv.slice(2);
writeFileSync(`${repo}/.editorconfig`, `# https://editorconfig.org\nroot = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\nindent_style = space\nindent_size = 2\ninsert_final_newline = true\ntrim_trailing_whitespace = true\n\n[*.md]\ntrim_trailing_whitespace = false\n`);
console.log(".editorconfig");
