# Lecstor AI Skills

A collection of reusable AI agent skills compatible with the [Agent Skills](https://agentskills.io) format and installable via Vercel's [`skills`](https://www.npmjs.com/package/skills) CLI (`npx skills`).

## Installation

Install skills from this repository into your AI coding agent (Claude Code, Cursor, Codex, Antigravity, GitHub Copilot, and others):

```bash
# Interactive install (choose skills and target agents)
npx skills add lecstor/lecstor-ai-skills

# List available skills without installing
npx skills add lecstor/lecstor-ai-skills --list

# Install a specific skill
npx skills add lecstor/lecstor-ai-skills --skill <skill-name>

# Install globally for your user profile
npx skills add lecstor/lecstor-ai-skills -g
```

### Managing Installed Skills

```bash
# Check for updates to installed skills
npx skills check

# Update installed skills to the latest versions
npx skills update
```

## Available Skills

| Skill | Description |
| --- | --- |
| [`bug-hunt`](skills/bug-hunt/SKILL.md) | Read-only codebase audit workflow hunting for real, reproducible defects across 16 concrete bug classes and producing a verified report without modifying code. |

## Repository Structure

```text
lecstor-ai-skills/
├── skills/                         # Public skills discovered by `npx skills`
│   └── <skill-name>/
│       ├── SKILL.md                # Required: YAML frontmatter + instructions
│       ├── references/             # Optional: on-demand reference docs
│       ├── scripts/                # Optional: helper scripts
│       └── assets/                 # Optional: templates or static assets
├── templates/
│   └── skill/
│       └── SKILL.md.template       # Starter template (not auto-discovered)
├── LICENSE
└── README.md
```

## Authoring a New Skill

1. Create a kebab-case directory under `skills/` (or run `npx skills init <skill-name>` inside `skills/`):

   ```bash
   mkdir -p skills/my-skill
   cp templates/skill/SKILL.md.template skills/my-skill/SKILL.md
   ```

2. Edit `skills/my-skill/SKILL.md`:
   - Set `name` in the YAML frontmatter to match the folder name (lowercase letters, numbers, and hyphens; max 64 characters).
   - Write a clear `description` explaining both **what** the skill does and **when** an agent should use it (max 1,024 characters).
   - Add `metadata.internal: true` if a skill is a work-in-progress and should be hidden from public discovery.

3. Test local discovery before pushing:

   ```bash
   npx skills add . --list
   ```

4. Add the new skill to the **Available Skills** table in this `README.md`, commit, and push to GitHub.

## License

[MIT](LICENSE)
