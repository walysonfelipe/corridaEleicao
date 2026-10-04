# Repository Guidelines

## Project Structure & Module Organization

The browser game is a small static project: `index.html` contains the page, `style.css` its responsive presentation, and `game.js` the race rendering and demo standings. `game.md` documents the game concept and how to use the prototype. No test or asset directories are currently needed.

## Build, Test, and Development Commands

Run `python3 -m http.server 8000` from the repository root and open `http://localhost:8000` to run the game. There is no build step or test/lint command configured. The browser fetches public TSE election JSON when available and falls back to clearly labeled demo data.

## Coding Style & Naming Conventions

Use two spaces for indentation in HTML, CSS, and JavaScript. Keep JavaScript browser-compatible and CSS selectors lowercase and descriptive. Treat TSE data as external input, handle unavailable files, and keep demo results visibly labeled. Use Markdown with descriptive headings and relative links for project documentation. No formatter or linter is configured.

## Testing Guidelines

There is no test framework or test suite in the current repository. If tests are added, place them in a dedicated test directory, name them for the behavior being checked, and document how to run them.

## Commit & Pull Request Guidelines

Git history is not available in this checkout, so no established commit-message convention can be confirmed. Write concise, imperative commit subjects (for example, `Document game setup`). Pull requests should explain the change and its rationale, list relevant checks, and include screenshots when a change affects a visual interface. Link related issues when available.

## Security & Configuration

Do not commit credentials, tokens, or machine-specific configuration. If the project gains environment-based settings, provide a safe example file with placeholder values and document required variables without including secrets.
