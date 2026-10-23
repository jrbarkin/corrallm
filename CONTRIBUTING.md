# Contributing

Pull requests are welcome. Open an issue before adding an adapter so we can agree on its scope. Treat every supported CLI equally; CLI-specific code belongs only in that CLI's adapter.

Contributions use the same [Apache-2.0 license](LICENSE) as corrallm (inbound = outbound), including its copyright and patent grants. There is no CLA.

Every commit must carry your `Signed-off-by:` trailer, certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/): you have the right to submit the contribution under its license. Read the certificate before signing; your sign-off becomes part of the public contribution record. Use:

```sh
git commit -s
```

Git adds your configured name and email, for example:

```text
Signed-off-by: Alex Contributor <alex@example.com>
```

Follow [AGENTS.md](AGENTS.md), including its test-first rules, architecture docs and done gate, before submitting a PR.
