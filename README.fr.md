*[English](README.md) · **Français***

<div align="center">

# Tacita

**Messagerie chiffrée de bout en bout, auto-hébergée, pour un cercle fermé.**

Une seule commande déploie toute la pile sur votre serveur ; vos proches l'installent
depuis le navigateur comme une application. Elle remplace les DM et groupes Instagram,
sans la surveillance ni la publicité.

[![Licence : MIT](https://img.shields.io/badge/licence-MIT-black.svg?style=flat-square)](LICENSE)
![État : pré-1.0](https://img.shields.io/badge/état-pré--1.0-orange.svg?style=flat-square)
![Protocole : Matrix](https://img.shields.io/badge/protocole-Matrix-000.svg?style=flat-square)
![Node : 22+](https://img.shields.io/badge/node-22%2B-5FA04E.svg?style=flat-square)
![Ubuntu 22.04 / 24.04](https://img.shields.io/badge/ubuntu-22.04%20%7C%2024.04-E95420.svg?style=flat-square)

</div>

<!-- HERO : remplacer par une capture d'une conversation, mobile, thème sombre.
     Puis ajouter une grille de trois : conversation · appel · réglages.
     ![Tacita](assets/hero.png) -->

> [!WARNING]
> Lisez **[THREAT_MODEL.md](THREAT_MODEL.md)** avant de confier quoi que ce soit à
> Tacita. C'est la version honnête de la phrase ci-dessus : ce que le chiffrement
> couvre, ce qu'il ne couvre pas, et où sont les arêtes vives — à commencer par la clé
> de récupération.

## Vue d'ensemble

Tacita n'est pas une application qu'on pointe vers le serveur de quelqu'un d'autre. C'est
**toute la pile**, déployée d'un bloc sur une machine qui vous appartient :

| Composant | Rôle |
| --- | --- |
| **Synapse** | serveur Matrix, salons chiffrés |
| **PostgreSQL** | sa base de données |
| **Garage** | stockage objet S3 des blobs média chiffrés |
| **LiveKit + Element Call** | appels audio et vidéo, en widget |
| **nginx** | terminaison TLS, certificats Let's Encrypt |
| **Passerelle push** | relais Web Push (VAPID) — Sygnal ne parle qu'APNs et FCM |
| **Service d'invitation** | liens à durée de vie bornée, résolus en identifiant |
| **La PWA** | application web mobile-first, installée depuis le navigateur |

Pour un compte Matrix existant, utilisez [Element](https://element.io) — il est
excellent, et ce n'est pas ce que fait Tacita. Pour une messagerie privée à douze
personnes qui vit entièrement sur votre machine, c'est exactement ça.

## Fonctionnalités

- **Chiffrement de bout en bout**, en direct et en groupe, crypto Rust (vodozemac) — [`messaging`](packages/messaging)
- **Appels audio et vidéo** chiffrés, via Element Call, aucun client RTC maison — [`calls`](packages/calls)
- **Photos, vidéos, vocaux et fichiers**, chiffrés côté client, un seul pipeline — [`media-pipeline`](packages/media-pipeline)
- **Hors ligne** — lire, chercher et composer sans connexion, et un rechargement ne perd rien — [`outbox`](packages/outbox)
- **Recherche locale** dans votre historique, dans un Web Worker, jamais sur le serveur — [`search`](packages/search)
- **Réponses, réactions, éditions, épingles, mentions, saisie**, et `envoi → envoyé → délivré → lu` — [`receipts`](packages/receipts)
- **Installable** sur iOS et Android, avec des notifications qui ne portent aucun contenu — [`push-gateway`](apps/push-gateway)
- **Liens d'invitation** à durée de vie bornée : un utilisateur existant en ajoute un autre — [`invite-tokens`](apps/invite-tokens)

## Ce que le serveur voit

Le serveur ne voit jamais le contenu d'un message. Il voit les métadonnées, et la nuance
compte :

- **qui parle à qui**, dans quels salons, et quand
- **la taille exacte de chaque pièce jointe** — donc, à débit quasi constant, la durée de
  chaque vidéo et de chaque vocal
- **les réactions**, qui ne sont pas chiffrées, et **les épingles**, qui sont de l'état
  de salon

> [!CAUTION]
> Votre **clé de récupération** transite vers le serveur au changement de mot de passe,
> elle déchiffre tout votre historique, et elle ouvre une session à elle seule. C'est
> tenable parce que l'opérateur, c'est vous. Ça cesse de l'être dès que vous hébergez
> pour des inconnus.

Tout est écrit dans **[THREAT_MODEL.md](THREAT_MODEL.md)**.

## Démarrer

### Prérequis

- **Ubuntu 22.04 ou 24.04**, root ou sudo. Autre distribution : installer soi-même
  Node 22+, pnpm, Docker avec le plugin compose v2 et certbot, puis lancer le script.
- **4 Go de RAM recommandés**, 2 Go minimum avec swap. L'application web est compilée
  sur votre machine pendant l'installation, parce que le build inscrit votre domaine
  dans le bundle — c'est de loin le moment le plus lourd.
- **Un domaine**, avec un enregistrement `A` pour lui *et* pour `call.<votre-domaine>`.

> [!IMPORTANT]
> Ports à ouvrir : `80/tcp` (certbot seulement, le temps du défi), `443/tcp`, `3478/udp`
> et `5349/tcp` (TURN), `7881/tcp` et `50000-50100/udp` (média des appels).
> [`install.sh`](install.sh) ouvre lui-même ceux du RTC quand `ufw` est là. Les oublier fait qu'un
> appel se connecte, affiche les participants, puis meurt à 15-20 secondes sans rien dire.

### Installation

Sur un serveur neuf, avec un domaine qui pointe dessus :

```sh
git clone https://github.com/adamAubry/tacita.git
cd tacita
./install.sh --domaine=chat.example.org --email=vous@example.org
```

Six étapes : prérequis, configuration, DNS, certificat, pile, vérification. Le script est
**reprenable** — s'il s'arrête, corrigez ce qu'il nomme et relancez-le : il repart où il
en était, et ne refait jamais ce qui est déjà fait.

À la fin, ouvrez votre domaine et créez le premier compte depuis l'application.
L'inscription est ouverte par choix sur une machine privée : lisez
[THREAT_MODEL.md](THREAT_MODEL.md) si ce n'est pas votre situation.

> [!TIP]
> `./install.sh --dev` installe sur une machine locale avec un certificat auto-signé, et
> `--oui` passe toutes les confirmations pour un lancement sans surveillance.

### Administration

L'outil `admin` n'a **aucune dépendance** — il tourne juste après `git clone`, sans
`pnpm install`, avec Node 22+ pour seule exigence.

```sh
pnpm admin init --domaine=chat.example.org --email=vous@example.org
pnpm admin dns          # les deux enregistrements A à créer, et leur état
pnpm admin certificat   # émet le certificat TLS, une fois le DNS en place
pnpm admin doctor       # diagnostique une pile qui tourne, sans rien toucher
```

Chaque commande nomme la suivante. Une option inconnue arrête la commande au lieu d'être
ignorée : `--domain` répond « voulais-tu dire `--domaine` ? ».

## Structure du dépôt

Un monorepo pnpm. Les paquets sont headless — zéro DOM, et aucune logique métier dans l'UI.

```
apps/
  web/            PWA Next.js 15 (App Router, Astryx UI) — compose les paquets
  admin/          l'outil de l'auto-hébergeur : init, dns, certificat, doctor
  push-gateway/   Matrix Push Gateway → Web Push (VAPID)
  invite-tokens/  liens d'invitation, résolus en identifiant et rien d'autre
packages/
  client-core/    session, crypto, store, sync — seul endroit où vit matrix-js-sdk
  messaging/      DM et groupes, envoi chiffré, réponses, réactions, éditions, épingles
  outbox/         file d'envoi persistante en IndexedDB, survit à un rechargement
  receipts/       envoi → envoyé → délivré → lu, observable par événement
  media-pipeline/ compression → chiffrement → upload, et son inverse
  search/         index Orama dans un Web Worker, persisté en IndexedDB
  calls/          orchestration MatrixRTC, URL du widget Element Call et driver
infra/            config-as-code : compose, Synapse, nginx, LiveKit, tests de fumée
```

Chaque paquet porte dans son [`README.md`](README.md) son contrat d'interface et ses **limites
assumées**. Ces limites ne sont pas de la communication : plusieurs sont tenues par des
tests qui échouent si le README cesse de les dire.

## État

Pré-1.0, et le dit. Le projet distingue deux portes, et vous devriez faire pareil :

```sh
npm test        # tests unitaires et de configuration, sur imitations
npm run smoke   # vrai Synapse, vraie crypto, vrai IndexedDB (Docker requis)
```

**Prouvé à l'exécution** : la crypto Rust réellement chargée, un salon effectivement
chiffré côté serveur, l'aller-retour chiffrement → serveur → déchiffrement, et la reprise
de session sans réseau.

> [!NOTE]
> **Non prouvé** : tout le reste. La passerelle push de bout en bout (vérifiée une fois à
> la main, aucun test ne la rejoue), le média contre un vrai serveur, LiveKit en charge.
> Rien n'a jamais été rendu dans un vrai navigateur par un test automatisé —
> [`apps/web/README.md`](apps/web/README.md) dit ce que ça laisse invérifié.

## Documentation

| Document | Ce qu'il couvre |
| --- | --- |
| [THREAT_MODEL.md](THREAT_MODEL.md) | ce qui est protégé, ce qui ne l'est pas, et pourquoi |
| [`infra/README.md`](infra/README.md) | le socle serveur, en détail |
| [`apps/web/README.md`](apps/web/README.md) | la PWA, et ce qu'elle ne prouve pas |
| `packages/*/README.md` | un contrat et une liste de limites par module |
