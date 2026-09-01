# licenses

Print the licenses of everything this binary was built from:

```sh
cashme licenses          # what went in, and under what
cashme licenses --full   # the license texts themselves
```

A cashme binary has its whole dependency tree compiled into it — 160 packages under
Apache-2.0, MIT, ISC and the Unlicense — and those licenses ask to be distributed with the
code. Which is awkward, because the three install routes do not all carry a file. The
release archives ship `THIRD-PARTY-NOTICES.md` beside the binary. A pear install does not:
`pear-install` mirrors one path out of the drive, `/by-arch/<host>/app/cashme`, and moves
that single file into place; the OTA updater copies the same one path over it. Nothing else
on the drive ever reaches the machine.

So the notices are inside the binary instead, and this is how to read them. `--full` prints
the same document the archives ship, byte for byte, including the NOTICE files reproduced
under section 4(d) of the Apache License:

```sh
cashme licenses --full > THIRD-PARTY-NOTICES.md
```

Nothing in the tree is copyleft. cashme itself is Apache-2.0.
