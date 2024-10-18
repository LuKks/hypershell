# hypershell

Spawn shells anywhere. Fully peer-to-peer, authenticated, and end to end encrypted.

```
npm i -g hypershell
```

## Usage

```sh
# Run a multi-purpose server
hypershell server # [-f keyfile] [--firewall filename] [--disable-firewall]

# Shell into the server
hypershell login key-or-name # [-f keyfile]

# Transfer files
hypershell copy [@host:]source [@host:]target # [-f keyfile]

# Local and remote port forwarding
hypershell tunnel key-or-name -L [address:]port:host:hostport # [-f keyfile]
hypershell tunnel key-or-name -R [address:]port:host:hostport # [-f keyfile]

# Create a key
hypershell keygen # [-f keyfile] [-c comment]
```

Use `--help` with any command for more information, e.g. `hypershell server --help`.

```js
const Hypershell = require('hypershell')

const hs = new Hypershell()
const keyPair = Hypershell.keyPair()

const server = hs.createServer({ firewall: [keyPair.publicKey] })
await server.listen()

const shell = hs.login(server.publicKey, {
  keyPair,
  stdin: process.stdin,
  stdout: process.stdout
})

await shell.ready()
await shell.fullyClosed()

if (shell.exitCode !== null) {
  process.exitCode = shell.exitCode
}

await shell.close()
await server.close()
await hs.destroy()
```

## Server

Server keys are automatically created on the first run at `~/.hypershell/id_server`.

```sh
hypershell server
```

`~/.hypershell/authorized_peers` file will be empty, denying all connections by default.

Public keys can be added to the list to allow them in real-time.

There is a `--disable-firewall` flag to allow anyone to connect (useful for public services like game servers).

#### Running multiple servers

Use `-f <filename>` to change the primary key.

Use `--firewall <filename>` to change the authorized peers list.

```sh
hypershell server -f ~/.hypershell/another_id_server --firewall ~/.hypershell/another_authorized_peers
```

#### Change the default shell

```sh
SHELL=bash hypershell server
```

## Login

Client keys are automatically created on the first run at `~/.hypershell/id`.

Connect to a server (they have to allow your public key):

```sh
hypershell login <server-key-or-name>
```

#### Known peers

Use the file `~/.hypershell/known_peers` to add peers by name like so:

```sh
# <name> <public key>
home nq98erpfiogzfptca3jcaum7atscfoiyu76ng9x7rfeboa9qeiat 
```

Now just `hypershell login home` (it saves you writing the entire public key).

#### Variadic command

```sh
hypershell login home -- /usr/bin/bash
```

#### Invite

Create a short seed for someone to join once into your server:

```sh
hypershell login home --invite
# One time invite: hkwsesi4dm1ng
```

Then someone can use it only once to log in:

```sh
hypershell login home --invite hkwsesi4dm1ng
```

They can add themselves into `~/.hypershell/authorized_peers` for permanent access.

## Copy

Upload a file or folder:

```sh
hypershell copy ./file.txt @home:/root/uploaded.txt
```

Download a file or folder:

```sh
hypershell copy @home:/root/database.json ./downloaded.json
```

#### Can use public keys

The public key of the server can be used directly (without `@`):

```sh
hypershell copy ./project nq98erpfiogzfptca3jcaum7atscfoiyu76ng9x7rfeboa9qeiat:/root/project
```

## Tunnel

#### Local port forwarding

Create a local proxy where every connection is forwarded to the server.

Example: Access a private service in the server but locally e.g. a database port.

```sh
hypershell tunnel home -L 3000:127.0.0.1:3306:127.0.0.1
```

#### Remote port forwarding

Create a remote proxy where every connection is forwarded locally.

Example: Expose your local development React.js app to the internet.

```sh
hypershell tunnel home -R 80:0.0.0.0:3000:127.0.0.1
```

#### Multiple tunnels at once

You can do this with both `-L` and `-R`.

```sh
hypershell tunnel home -L 5000:5900:127.0.0.1 -L 3000:3389:127.0.0.1
```

#### Restrict tunnel server

A server runs with full access by default, including forwarding to all hosts and ports.

You can run the server as tunnel only, and limiting to a specific set of addresses.

Example: You want to safely share your React.js app to someone.

```sh
hypershell server --protocol tunnel --tunnel 127.0.0.1:3000
```

Range of ports are also valid: `--tunnel 127.0.0.1:4100-4200`

## API

#### `const hs = new Hypershell([options])`

Create a Hypershell instance.

Available options:

```js
{
  dht,
  bootstrap
}
```

#### `await hs.destroy()`

Close the Hypershell instance.

## Server

#### `const server = hs.createServer([options])`

Create a Hypershell server.

Available options:

```js
{
  keyPair,
  seed,
  firewall: [], // Set to null to allow everyone
  verbose: false,
  protocols: ['shell', 'copy', 'tunnel', 'admin'],
  tunnel: {
    // By default, allows the client to tell the server to connect to anything
    allow: null // Limit it with a an array of addresses like ['127.0.0.1:3000']
  }
}
```

Can also edit `server.firewall = [...]` in real-time.

## Login

#### `const shell = hs.login(publicKey, [options])`

Create a Shell instance.

Available options:

```js
{
  keyPair,
  seed,
  rawArgs,
  stdin,
  stdout,
  onerror
}
```

#### `await shell.ready()`

Waits until is connected to the server or throws if couldn't connect.

#### `await shell.close()`

Close the instance.

#### `await shell.fullyClosed()`

Will resolve when the shell is fully closed (e.g. `exit` command).

#### `shell.exitCode`

Indicates the exit code from the remote shell, by default `null`.

## Copy

#### `const transfer = hs.copy(publicKey, [options])`

Create a Copy instance.

Available options:

```js
{
  keyPair,
  seed,
  permissions: [], // Possible values: 'pack' and 'extract'
  onerror
}
```

#### `await transfer.upload(source, destination)`

Upload a file or folder.

#### `await transfer.download(source, destination)`

Download a file or folder.

#### `await transfer.close()`

Close the instance.

## Tunnel

#### `const tunnel = hs.tunnel(publicKey, [options])`

Create a Tunnel instance.

Available options:

```js
{
  keyPair,
  seed,
  allow: [] // By default, it blocks all remote connect commands
}
```

#### `const proxy = await tunnel.local(localAddress, remoteAddress)`

Create a local proxy server that forwards to the remote address.

Throws an error if initially can't connect to the server.

In case of disconnections, it automatically recovers on the next local connection.

#### `const proxy = await tunnel.remote(remoteAddress, localAddress)`

Create a proxy on the server that forwards to the local address.

Throws an error if initially can't connect to the server.

In case of disconnections, it reconnects on background and resends the remote server command.

#### `await proxy.close()`

Stop the proxy.

#### `await tunnel.close()`

Close the instance.

## Admin

#### `const admin = hs.admin(publicKey, [options])`

Create an Admin instance.

Available options:

```js
{
  keyPair,
  seed
}
```

#### `const shortSeed = await admin.createInvite([options])`

Returns an 8-byte seed to be used to make a key pair.

The public key derived from this short seed is only allowed once in the firewall.

Available options:

```js
{
  expiry: 60 * 60 * 1000
}
```

#### `await admin.close()`

Close the instance.

## License

Apache-2.0
