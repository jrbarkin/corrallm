# Contributing

Pull requests are welcome. For a new adapter, open an issue first to agree on its scope. Treat every supported CLI equally and keep CLI-specific code inside its adapter.

Read [AGENTS.md](AGENTS.md) and the relevant [architecture doc](docs/architecture/overview.md) before changing code. Add a failing regression test before fixing a bug, use fake CLIs in tests, and document behavior changes alongside the code. Run the local checks listed in AGENTS.md; CI runs the complete gate. In your pull request, explain the resulting behavior and list the checks you ran and any you could not run.

Write documentation for readers who know only this public repository. Use feature names, describe the behavior that exists, verify claims against the implementation and link to sources readers can access.

Contributions use the same [Apache-2.0 license](LICENSE) as corrallm (inbound = outbound), including its copyright and patent grants. There is no CLA.

Every commit must carry your `Signed-off-by:` trailer, certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/): you have the right to submit the contribution under its license. Read the certificate before signing; your sign-off becomes part of the public contribution record. Use:

```sh
git commit -s
```

Git adds your configured name and email, for example:

```text
Signed-off-by: Alex Contributor <alex@example.com>
```

For a security concern, follow [SECURITY.md](SECURITY.md) instead of opening a public issue or pull request.
