You are the implementing engineer. Build the app specified in SPEC.md in this directory.

Rules:
1. Read SPEC.md fully first. It is the source of truth; do not edit it. If something is
   ambiguous, choose the simplest option that satisfies the spec and note it in README.md
   under "Decisions".
2. Work only inside this directory. Do not install packages, add a package.json with
   dependencies, use a framework, a bundler or any CDN. Plain HTML/CSS/vanilla JS ES modules.
3. Follow the milestones in SPEC.md section 12 in order. After each milestone:
   run `node --test tests/`, fix failures, then `git add -A && git commit -m "M<n>: <summary>"`.
4. Put all date, status, stock and CSV logic in logic.js as pure functions, and test them in
   tests/logic.test.js with node:test and node:assert. Cover every rule in SPEC.md section 7.
5. Never insert user-entered text with innerHTML. Use textContent or a small escape helper.
6. Never use window.alert, window.confirm or window.prompt; build confirmations in the page.
7. When all milestones are done, verify every checkbox in SPEC.md section 11 that can be checked
   from the command line (tests, no external URLs in source, files present), then print a short
   report: what was built, test results, any acceptance criteria you could not verify and why.
