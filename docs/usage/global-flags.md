# Global flags

```sh
cashme --version                      # print the version
cashme --storage ./wallet balance     # use a specific storage directory
cashme --no-updates balance           # skip the OTA updater for this run
cashme --update-window 60000 balance  # how long the updater waits, in ms
cashme --proxy socks5://127.0.0.1:9050 deposit -a 100   # go out through a proxy
cashme --dht-interface en0 get --dht  # pin the hyperdht to one local address
```
