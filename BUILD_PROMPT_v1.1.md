You are the implementing engineer. The app in this directory (v1.0, milestones M1-M6 plus a fix
commit) is built and working. Implement SPEC.md section 13 (v1.1 addendum: Help page and Desktop mode).

Rules:
1. Read SPEC.md section 13 fully, then skim sections 4-9 for the existing constraints. Run
   `git log --oneline` and `node --test tests/` first. Do not edit SPEC.md.
2. Extend the existing code; do not rewrite working v1.0 features or change the data model.
3. Keep the phone layout (< 768 px) exactly as it is now. Note: styles.css starts with
   `[hidden] { display: none !important; }` - keep it; use the `hidden` attribute or media
   queries to show/hide the sidebar, tab bar and FAB.
4. Same constraints as before: plain HTML/CSS/vanilla JS ES modules, no packages, no CDN, no
   network calls, never innerHTML with user text, no alert/confirm/prompt.
5. Do M7 then M8. After each: `node --test tests/`, `node --check` on changed JS files, then
   `git add -A && git commit -m "M<n>: <summary>"`.
6. Bump CACHE_VERSION in sw.js and add any new files to its cache list.
7. Scratch files go in .tmp/ (git-ignored), not /tmp.
8. Finish with a short report: what was built, test results, which section 13.3 checks you
   verified from the command line and which need a browser.
