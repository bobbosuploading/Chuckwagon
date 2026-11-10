# Chuckwagon

## TestFlight builds and CHANGES.txt

`CHANGES.txt` is the plain-text list of what's new in each TestFlight build. The owner pastes a build's section into TestFlight's "What to Test" box.

- Whenever you change `CURRENT_PROJECT_VERSION` in `ios/project.yml`, add a `Build N` section at the top of `CHANGES.txt` in the same pull request. Copy the layout of the section below it.
- Write for testers: plain words, what they can see or try, no PR numbers or code names. Put notes that aren't for testers on lines in `[square brackets]`.
- If a change testers would notice merges after the current build's section was written but before that build is uploaded, add it to that section.
- `scripts/check-changes.sh` (run by the "Build iPhone app" workflow) fails when the current build number has no section or its section is over TestFlight's 4,000 characters.
