# RinnePad

A client-side PDF editor for the browser, built for Aki. Open a PDF, annotate it, and download the edited copy. The file never leaves your browser; there is no backend and no build step (static site on GitHub Pages).

## Features

- Open by file picker or drag-and-drop anywhere. Non-PDF, corrupt and password-protected PDFs are rejected with a clear message.
- Continuous scroll view, lazily rendered (large files stay usable), zoom in/out/fit-width, page indicator, jump-to-page, thumbnail sidebar.
- Tools: select/move/resize/delete, text (Helvetica/Times/Courier, size, colour, multi-line, double-click to edit), highlight, rectangle, ellipse, line, arrow, freehand pen, whiteout, insert image (PNG/JPEG; other types are converted to PNG).
- Page operations: rotate 90, add a blank page after the current page (same displayed size, accepts every tool), delete (not the last page, blanks count as pages), reorder (up/down on thumbnails).
- Undo/redo for every edit including page operations. Shortcuts: Delete/Backspace, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Esc.
- Download as `<name>-edited.pdf`. Original page content stays vector; annotations are drawn on top. A warning is shown if you leave with unexported edits.

## Files

- `index.html`, `editor.js`: UI and state.
- `pdf-export.js`: export and coordinate logic (annotations are stored in unrotated PDF user space).
- `test.html`: browser self-check. Serve the folder (`python3 -m http.server`) and open `/test.html`; it prints PASS or FAIL.

## Libraries (CDN, pinned)

- pdf.js 4.10.38 (viewing; never use a version below 4.2.67, see CVE-2024-4367)
- pdf-lib 1.17.1 (export)
- Tailwind CSS and Font Awesome (styling)

## Known limits

- Text with characters outside WinAnsi (Thai, CJK, emoji) is exported as an image, not selectable text.
- Password-protected PDFs (including owner-password-only) are not supported.
- Whiteout only covers content visually: the text underneath stays in the file and can be extracted, so it is not redaction.
- Editing existing PDF text is not supported; use whiteout plus a new text box.
