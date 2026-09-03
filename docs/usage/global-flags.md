# Global flags

```sh
cashme --version                      # print the version
cashme --storage ./wallet balance     # use a specific storage directory
cashme --no-updates balance           # skip the OTA updater for this run
cashme --update-window 60000 balance  # how long the updater waits, in ms
cashme --proxy socks5://127.0.0.1:1080 deposit -a 100   # go out through a proxy
cashme --dht-interface en0 get --dht  # pin the hyperdht to one local address
```

`--no-updates` covers the run it is typed on. To stop the updater for every run instead:

```sh
export CASHME_NO_UPDATES=1
```

Presence is what counts, the same way `CASHME_PROXY` is read — any non-empty value disables
updates, `CASHME_NO_UPDATES=0` included. To turn updates back on, unset it. `--no-updates`
outranks it, and nothing overrides it in the other direction.
