# browser-process

Child processes that never open a console window. On Windows a console program started by a process
without a console (a service, a GUI, a detached process) gets a new console window; when the parent is
attached to a console the child shares it, so `CREATE_NO_WINDOW` is only added when the parent has none
(it would otherwise detach the child from an interactive terminal). On every other platform the crate adds
nothing and returns a plain `std::process::Command`.

- `command(program)` builds a `Command` with the right creation flags.
- `NoWindow::no_window` does the same for an existing `Command`.
- `has_console()` and `creation_flags()` expose the decision.

Legacy published name: `bun_browser_process` (crates.io, 1.4.8). This crate is the restored source under the
repository's own name; it is not published.

## Test

```sh
cargo test -p browser-process
cargo clippy -p browser-process --all-targets -- -D warnings
```
