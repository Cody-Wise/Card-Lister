# Agent Instructions

## Rules

- Inspect existing patterns before editing.
- Make small, reversible changes.
- Ask before changing database schemas.
- Never expose secrets.
- Run tests or syntax checks after edits.

## Commands

- Install deps: npm install
- Run tests: npm test
- Lint: npm run lint
- Start dev: npm run dev

# Agent Workflow

## Planner

- Reads requirements.
- Finds affected files.
- Creates implementation plan.
- Does not edit files.

## Implementer

- Edits files.
- Makes small reversible changes.
- Runs tests or syntax checks.

## Reviewer

- Reviews diffs only.
- Looks for bugs, security issues, broken assumptions, and missing tests.
- Does not edit files.

## Fixer

- Applies reviewer-approved fixes only.
- Runs final verification.
