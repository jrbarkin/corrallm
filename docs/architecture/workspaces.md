# Workspaces

[Architecture index](overview.md) · [Canonical instructions](../../AGENTS.md)

B9a gives independent work independent checkouts: each canvas's outermost group, or lone agent, works in a Git worktree of its own of the repository picked as the canvas's project folder. The records are schema 3's (see [Store](store.md)); this page is the Git and filesystem side, in `src/main/core/workspaces/`. Q32 is answered yes (Claude Code trusts a worktree inside a trusted folder), so new checkouts live inside the picked checkout.

## The Git runner

`src/main/core/workspaces/git.ts` is the one runner every workspace Git call goes through (`GitRunner`); no other file of the folder starts a process (`git.test.ts` scans it). B9b's diffs and merges are to reuse it.

- No shell. Git is run by absolute path, found only in the PATH's absolute folders: a relative entry such as `.` could otherwise find a `git` a repository planted in the folder it runs in. Arguments are the core's own, refs and OIDs of core shapes, paths after `--end-of-options`.
- Fixed options on every call: `SAFE_GIT_OPTIONS` (no fsmonitor, no implicit bare repository), `core.hooksPath` set to an empty folder of the core's own (no repository hook runs, whichever hooks folder the repository's configuration names; the folder is checked to be a real, private, empty folder before every call, and nothing runs otherwise), `submodule.recurse=false`, `protocol.allow=never` (no transport at all: no fetch, so no lazy fetch of a partial clone and no ssh or credential helper), `gc.auto=0` and `maintenance.auto=false` (no automatic prune, and no gc detaching from the core's process group).
- Filter drivers: each driver configured where a call runs (`inspect`, `git config --list -z --name-only`, so includes and conditional includes are read as Git reads them in that folder) has its clean, smudge and process commands blanked and its required flag cleared, so no filter runs, Git LFS's included (its pointers are checked out as they are). A driver whose name holds `=` can't be named by `-c`, so it is refused, as are `core.worktree` (it would redirect the checkout) and configured hooks (`hook.*`, which `core.hooksPath` doesn't reach). Configuration Git can't read fails the call: nothing runs on what couldn't be inspected.
- Patches (`patch`) add `safeGitDiffArgs` from `src/main/git.ts`: no external diff, textconv or filter driver.
- The environment is the agents' (their PATH and home), every `GIT_` variable removed (none can redirect a call, as GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE would, or configure one, as GIT_CONFIG_PARAMETERS or GIT_CONFIG_COUNT would), then `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1` and `LC_ALL=C`.
- Bounded: each call has a timeout (15 s unless it says otherwise) and an output bound (1 MiB; a configuration listing 4 MiB); what a failed git said is kept to 2,000 characters, for diagnostics only. Its exit codes that answer (Git's 1 for "there is none") are answers; any other fails it (`GitError`, with a fault: git-missing, git-unsupported, hooks, config, refused, timeout, output or failed).
- Owned: with the core's process owner (`core/children.ts`), every git, its version check included, is a recorded child in a private process group, ended whole when it takes too long or prints too much, and refused once the core is closing.
- Git older than 2.36 is refused (`worktree list --porcelain -z` reads paths of any shape).

What this protects is corrallm running a repository's programs itself. A worktree is checkout isolation, not a sandbox: agents run their own commands in it, and a process already running as the user can change a repository's configuration whenever it likes.

## Repository discovery

`src/main/core/workspaces/discovery.ts` (`discoverRepository`) takes the picked folder, a TrustedPath, and finds the checkout it is: its real top level, its own and common Git directories, the repository's identity (its common directory's inode and object format, so one deleted and cloned again at the same path is another), its HEAD (branch ref, or none when detached, and commit) and the filter drivers configured in it. It refuses, saying why in a sentence for the person:

- a folder inside a repository (`subdirectory`, naming the top level to choose instead): never widened to the whole repository;
- a checkout that is really somewhere else (`redirected`): a `.git` symlink, a `.git` file naming another repository, a linked worktree whose registration's back-pointer doesn't name it, `core.worktree`, a top level elsewhere, or a folder Git hasn't registered as a checkout;
- configuration the runner can't neutralize (`config`), a `.git` Git can't read or a path with control characters (`unsupported`), a repository with no commit (`no-commit`: "Make the repository's first commit, then retry."), a missing or unreadable folder, and Git missing, too old or failing.

Only Git's own "not a git repository", with no `.git` there at all, is a folder that isn't one (`not-git`), whose agents share it as before. A picked linked worktree is supported: it, not the main checkout, is the base. `recordRepository` keeps what was found in the `repository` table, within a write, by real path and identity: one kept already is found again (its picked path and common directory as they are now), its workspaces' folder never moved; a new one gets this profile's folder inside its checkout.

## The owned root

`src/main/core/workspaces/owned.ts`. A repository's checkouts go in `<checkout>/.corral/worktrees/<profile-id>/`, each named by its workspace's id. `ensureOwnedRoot` makes it if it is missing and verifies it before anything is written in it; `verifyOwnedRoot` only verifies. Every folder from the checkout's real path down must be a real folder (a symlink anywhere, which a repository could commit, is refused, and nothing is written where it leads), the user's, and the last one private (0700), marked by the core (`.corrallm-owner`, binding it to the repository record). One already there that the core didn't make is refused, never adopted, unless it is empty (a crash between making it and marking it). A root outside the checkout is refused.

`excludeOwnedRoot` adds `/.corral/worktrees/` to the repository's local `info/exclude`, in its common directory, once, keeping what it holds: never the tracked `.gitignore`, never through a symlink, never a file it can't read whole (over 1 MiB). The checkout's status, `git add -A` and its agents then never take the workspaces for its files, nor add them as embedded repositories.
