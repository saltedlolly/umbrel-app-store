<h1><a href="https://saltedlolly.com">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/saltedlolly/saltedlolly-wordmark-dark-bg.png">
  <img alt="saltedlolly" src="../assets/saltedlolly/saltedlolly-wordmark-light-bg.png" height="36" align="right">
</picture>
</a>
Nito for Umbrel</h1>

Run your own [Nito](https://nito.network/) node on your Umbrel, with a dashboard that shows what's happening on the network as it happens.

Nito is a SHA-256 proof-of-work blockchain built on Bitcoin Core, with one-minute blocks and coins issued over 200 years. It launched fairly in August 2024, with no premine. Running a node means your Umbrel keeps its own full copy of the blockchain, checks every block for itself, and passes blocks and transactions on to other nodes, which makes the network stronger.

The node has no wallet. It's for following and supporting the network, not for holding coins.

## Getting started

1. Add the saltedlolly Community App Store to your Umbrel ([how](https://github.com/saltedlolly/umbrel-app-store#-how-to-access-the-app-store-on-your-umbrel)).
2. Install **Nito**.
3. Open it. The node starts downloading and checking the blockchain from the beginning. The dashboard shows how far it has got and roughly how long is left. Depending on your Umbrel and your connection, this takes from a few minutes to an hour or so.
4. Optional, but it helps the network: [open port 8820](#help-the-network-open-port-8820) on your router.

The blockchain takes about 700 MB today and grows slowly.

## The dashboard

The dashboard opens without Umbrel's login, because it only shows information: it has no settings or controls, and it never shows your peers' addresses.

- **Latest blocks:** the newest blocks as a chain, with each new one sliding in when it's found, about once a minute, and a timer since the last one.
- **At a glance:** block height, how many nodes you're connected to (in and out), transactions waiting, chain size, uptime, node version and network.
- **Time between blocks:** how long each block took against the one-minute target, with a moving average line so you can see how closely the network sticks to it.
- **Transactions per block** and the **mempool** (transactions waiting to go into a block).
- **Connected peers:** a world map of the countries the nodes connected to yours are in, and which versions of Nito they run.
- **Network hashrate:** how much mining power the whole network has.
- **Who found the blocks:** which pools and miners found the last day's blocks.
- **Your node's traffic:** how fast your node is uploading and downloading, and the totals since it started.
- **Time ranges:** most charts can show the last hour, 24 hours, 7 days or 30 days.
- **Did you know?** A fact about Nito at the bottom, changing every minute, from [NitoFacts](https://nitofacts.nito.tools).
- Light and dark themes, with a picker at the top right.

## The Orchard upgrade (Nito Core 4)

Nito Core 4.0.0 adds **Orchard**, optional private transfers. A fully private transfer hides who sent it, who received it and how much, while every node can still check it follows the rules. Private funds use a new kind of address, called Bech32x, starting with `nito1x`. Ordinary transfers, mining and block rewards carry on as before. [Learn more on nito.network](https://nito.network/en/network/#orchard).

It's a hard fork: it switches on at block **1,165,432**, around the end of December 2026, and every node must run Nito Core 4 or later by then. This app already does, so there's nothing for you to do. Until it switches on, the dashboard shows a countdown, the expected date and how many of your peers are ready. Afterwards, it shows that it happened for a month.

The first time the node starts on version 4, it builds a new index, which takes a while and uses a little extra disk space. Once it has started on version 4, it can't go back to version 3.

## Help the network: open port 8820

Your node connects out to other nodes on its own, but other nodes can only connect **in** to it if port `8820` (TCP) is forwarded to your Umbrel on your router. Nodes that accept incoming connections make the Nito network stronger. The dashboard tells you if nobody has connected in after 30 minutes, and shows a tick once someone has.

1. Give your Umbrel a fixed local address on your router (often called a *DHCP reservation*), so the rule keeps pointing at it.
2. In your router's settings, find *Port forwarding* and forward TCP port `8820` to that address, port `8820`.

Every router is different: search for your router's model and "port forwarding" for exact steps. Only do this if you're comfortable with your Umbrel accepting connections from the internet on this port. Only the Nito node listens on it.

## Your data and backups

- The blockchain is stored in the app's own folder. It survives restarts and updates, and it's deleted if you uninstall the app.
- The blockchain is **not included in Umbrel backups**, because your node can download it again. After restoring a backup, the node simply catches up from the network.
- The node's small settings files and the dashboard's chart history are backed up. The node has no wallet, so there's nothing else to keep safe.

## Privacy

- **Peer countries** are looked up in a database built into the app ([DB-IP](https://db-ip.com)'s free country list), so peer addresses never leave your Umbrel.
- **NitoFacts** are fetched by your Umbrel from nitofacts.nito.tools every few hours. Your browser doesn't contact the site.
- **Update notices:** the dashboard checks this app store on GitHub for a newer version of the app.
- Everything else on the dashboard comes straight from your own node.

Like any node, yours connects to other Nito nodes on the internet, so they can see your Umbrel's internet address.

## Updates

New versions arrive through Umbrel's normal app updates. The first three numbers of the version always match the Nito Core version the node runs. Later releases add a fourth number, for example v4.0.0.1, for dashboard improvements or a rebuilt node image.

## How the node is built

The node isn't downloaded as a ready-made program. It's compiled from Nito Core's published source code by [docker-nito](https://github.com/Nito-Tools/docker-nito), so what runs on your Umbrel can be traced back to that source. Nito's own pre-built downloads have no independent proof of how they were built. docker-nito images are rebuilt each month when there are security updates, and each new build reaches this app automatically after two days.

## Credits

- **Nito**: [NitoNetwork/Nito-core](https://github.com/NitoNetwork/Nito-core)
- **Node image**: [Nito-Tools/docker-nito](https://github.com/Nito-Tools/docker-nito)
- **Packaging and dashboard**: Olly Stedall (saltedlolly)
- **Country lookups**: [IP Geolocation by DB-IP](https://db-ip.com) (CC BY 4.0)
- **World map**: [world-atlas](https://github.com/topojson/world-atlas) (Natural Earth, public domain)

## Support

For problems with this Umbrel app, open an issue at [saltedlolly/umbrel-app-store](https://github.com/saltedlolly/umbrel-app-store/issues).
