# RepoPilot

RepoPilot is a lightweight, browser-based explorer for public GitHub repositories. Paste a repository URL to browse its files, read source code, and get an at-a-glance view of its structure and technologies.

## Features

- Fetches repository metadata, the file tree, and language statistics from the GitHub REST API.
- Browses folders and files with filename search and filters for HTML, CSS, JavaScript, images, and documentation.
- Reads text files with line numbers, in-file search, and copy-to-clipboard controls.
- Previews images and displays a README preview when one is available.
- Summarizes repository details and visualizes file types, folders, and languages in Project DNA.
- Offers rules-based project observations, clearly marked as inferred rather than AI-generated.
- Shows loading and error states for invalid URLs, unavailable repositories, and API limits.

## Run locally

No build step, package manager, or backend is required.

1. Download or clone this repository.
2. Open `index.html` in a modern browser.
3. Paste a public repository URL such as `https://github.com/octocat/Spoon-Knife`, then select **Analyze repository**.

An internet connection is required to load repository data and optional web fonts. If your browser restricts requests from local files, serve the folder with any static file server and open the resulting local URL.

## Files

- `index.html` — page structure and interface sections.
- `style.css` — responsive dark-theme styling.
- `script.js` — GitHub API requests, file navigation, code reading, and project analysis.

## Limitations

- Only public repositories are supported. Private repository access requires a secure authenticated backend; putting a personal access token in browser code would expose it.
- Requests are unauthenticated and subject to GitHub's API rate limits.
- Very large repositories are capped at 5,000 files in the explorer to keep the browser responsive.
- Individual text files larger than 5 MB are not previewed in the browser; open them on GitHub instead.
- Project purpose, entry points, folder roles, and file connections are heuristic observations based on repository metadata and sampled files. They may be incomplete or incorrect.

