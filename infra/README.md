# infra — socle serveur

Config-as-code : PostgreSQL, Synapse, Keycloak (OIDC + WebAuthn), MinIO (S3),
reverse proxy nginx, et le **raccordement** de deux services livrés ailleurs — la
passerelle Web Push et le service de liens d'invitation.
Hors scope : LiveKit/TURN/well-known, le *code* de la passerelle push et celui du
service de liens.

## Deux environnements

Ce README décrit le socle et **la machine de développement**. Le staging — VPS Ubuntu,
vrai domaine, vrai certificat, shard servi par le proxy — a son propre runbook :
**[`staging/README.md`](staging/README.md)**. Les deux partagent [`docker-compose.yml`](docker-compose.yml) ; tout ce
qui les sépare vit dans un overlay chargé volontairement (règle 6 de [`CONTRIBUTING.md`](../CONTRIBUTING.md)) :

| | Compose | Shard | Certificat |
| --- | --- | --- | --- |
| dev | `docker-compose.yml` + [`smoke/docker-compose.yml`](smoke/docker-compose.yml) | `pnpm --filter web dev` sur l'hôte, `SHARD_ORIGIN=http://localhost:3000` | auto-signé, CA à importer |
| staging | `docker-compose.yml` + [`staging/docker-compose.yml`](staging/docker-compose.yml) | service `web`, servi sur `SERVER_NAME`, `SHARD_ORIGIN` vide | Let's Encrypt |

Les deux overlays ne se composent **jamais** ensemble : [`smoke/`](smoke) publie PostgreSQL et
l'API Synapse sur l'hôte et installe un CA de développement dans le magasin de confiance
de Synapse — trois choses qui n'ont rien à faire sur une machine publique.

## Démarrage

```sh
cp .env.example .env        # remplir les secrets
./proxy/generate-dev-certs.sh   # certs auto-signés, dev uniquement
docker compose up -d
```

Créer un compte se fait **depuis l'app** : identifiant et mot de passe, sans code
d'invitation. Le script d'admin reste là pour un compte de service ou
pour dépanner sans navigateur — il n'est plus le chemin normal :

```sh
docker compose exec synapse register_new_matrix_user \
  -c /data/homeserver.yaml http://localhost:8008
```

### Résoudre le nom depuis l'hôte

**Quatrième cause de la même famille que les trois du login OIDC ci-dessous, du côté
de l'hôte au lieu du réseau Docker.** L'alias réseau de `smoke/docker-compose.yml` fait
résoudre `SERVER_NAME` *entre conteneurs* — il ne fait rien pour le navigateur. Sans
cette étape, `pnpm --filter web dev` redirige vers `https://${SERVER_NAME}/…` et le
navigateur n'y trouve personne. Symptôme trompeur : la redirection est **correcte**
(renvoie à l'OIDC sans écran intermédiaire), c'est le nom qui ne mène nulle
part.

Aucune variable du shard n'y change quoi que ce soit. Le flux de connexion **sort de
l'application** : Synapse répond `302` vers Keycloak sous `https://${SERVER_NAME}/auth`,
et le navigateur doit résoudre ce nom-là. Pointer `NEXT_PUBLIC_HOMESERVER_URL` vers
`http://localhost:8008` déplace la panne d'un saut, sans la corriger.

Une ligne dans le fichier hosts, avec les deux noms que porte le certificat :

```
127.0.0.1 chat.example.org call.chat.example.org
```

- **Linux / macOS** : `/etc/hosts`.
- **WSL2** : le navigateur tourne côté **Windows**, donc c'est
  `C:\Windows\System32\drivers\etc\hosts` (éditeur lancé en administrateur) qui compte —
  le `/etc/hosts` de WSL ne sert qu'aux appels depuis le shell (`curl`, suite de fumée).
  `127.0.0.1` suffit dans les deux : WSL2 fait suivre localhost jusqu'au proxy.

Puis **approuver le CA de dev** (`proxy/certs/fullchain.pem`) dans le navigateur.
Accepter l'exception de sécurité affiche l'application, mais ne suffit pas : sans
confiance réelle, le service worker ne s'installe pas — exige un contexte
sécurisé. Pour tester la PWA, il faut l'import.

Le nom lui-même se change dans `infra/.env` (`SERVER_NAME`), suivi de
[`./proxy/generate-dev-certs.sh`](proxy/generate-dev-certs.sh) pour que les SAN suivent, et de la recopie des trois
URLs dans `apps/web/.env.local` — voir [`apps/web/.env.example`](../apps/web/.env.example). Les deux fichiers sont
ignorés par git : chaque environnement garde le sien, le dépôt ne porte que les exemples.

## Versions épinglées

| Service | Version | Digest |
|---|---|---|
| Synapse | v1.155.0 (2026-06-16) | `sha256:a87d002f…` |
| PostgreSQL | 16 | `sha256:33f923b0…` |
| Keycloak | 26.7.0 | `sha256:0f198be2…` |
| nginx | 1.27-alpine | `sha256:65645c7b…` |
| MinIO | RELEASE.2025-09-07 | `sha256:14cea493…` |
| push-gateway (base Node) | 22-alpine (2026-08-03) | `sha256:c610fcdf…` |

Digests complets dans `docker-compose.yml`, résolus via `docker buildx imagetools
inspect` au moment de l'écriture (2026-08-02) — à revérifier avant tout bump de
version.

**MinIO** : dernière image publiée en septembre 2025, le dépôt upstream a été
archivé début 2026 (plus de mises à jour de sécurité). Convient pour le dev
local ; en production, pointer `s3_storage_provider` vers un vrai bucket
S3-compatible maintenu (OVH, Scaleway, AWS) via les mêmes variables d'env.

## annuaire ouvert, et sa reconstruction

`user_directory.search_all_users: true` (tranchée le 21/08/2026). Le défaut de
Synapse ne liste que les comptes avec qui on partage déjà un salon ou qui sont dans un
salon public : ce déploiement n'en a aucun, donc l'annuaire ne répondait à personne, et
« Ajouter un ami » exigeait de connaître l'identifiant exact.

**Ce que ça expose, et qui est assumé** : tout compte peut énumérer les
autres par préfixe de nom d'affichage ou d'identifiant. Aucun contenu de message n'entre
dans l'annuaire.

**Le réglage n'est pas rétroactif tout seul.** Les comptes créés *avant* lui restent
absents de l'index tant que l'annuaire n'a pas été reconstruit — et le symptôme est
exactement celui qu'on venait de corriger : une recherche par nom qui ne rend rien. La
doc de la version déployée (v1.155, `user_directory.html`) donne la procédure : « use the
admin API and execute the job `regenerate_directory` ». Avec un access token
d'administrateur :

```sh
curl -X POST http://localhost:8008/_synapse/admin/v1/background_updates/start_job \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"job_name": "regenerate_directory"}'
```

La tâche tourne en fond ; « depending on the size of your homeserver (number of users and
rooms) this can take a while ». À rejouer à chaque fois que ce réglage change.

## authenticated media (Synapse v1.155.0)

Vérifié dans le changelog Synapse : `enable_authenticated_media` est passé à
`true` par défaut en **v1.139.0** (2024-09), et depuis **v1.146.0** les
anciens endpoints non authentifiés (`/_matrix/media/v3/download`,
`/_matrix/media/v3/thumbnail`) répondent **404** — ils ne sont plus un simple
fallback dépréciés mais deux voies mortes.

Conséquence pour le client : tout accès média — y compris
le téléchargement du blob chiffré opaque — doit passer par les endpoints
authentifiés (`/_matrix/client/v1/media/download/{serverName}/{mediaId}` et
variante thumbnail) avec l'access token en en-tête. Aucune URL média publique
ne doit être supposée. (Rappel : les vignettes de média chiffré ne sont de
toute façon jamais demandées au serveur.)

## passerelle Web Push

Le service de `push-gateway` est construit et démarré par ce compose. Il n'a **aucun
port publié** : `/_matrix/push/v1/notify` n'a pas d'authentification (la
subscription complète arrive dans le payload de Synapse), et le publier sur
l'hôte ferait de la passerelle un relais de push ouvert. Seule sort la clé
publique VAPID, par le proxy.

**Ce que le client doit faire :**

1. Lire la clé publique sur `https://<SERVER_NAME>/push/config` →
   `{"vapid_public_key": "…"}`.
2. S'abonner au Web Push du navigateur avec cette clé.
3. Enregistrer le pusher auprès de Synapse, `POST /_matrix/client/v3/pushers` :

```json
{
  "kind": "http",
  "app_id": "org.tacita.web",
  "pushkey": "<endpoint de la PushSubscription>",
  "app_display_name": "Tacita",
  "device_display_name": "Navigateur",
  "lang": "fr",
  "data": {
    "url": "http://push-gateway:8008/_matrix/push/v1/notify",
    "p256dh": "<clé p256dh de la subscription>",
    "auth": "<clé auth de la subscription>"
  }
}
```

L'URL du pusher est **le nom interne du service**, pas une URL publique : c'est
Synapse qui appelle cette URL, depuis le réseau du compose. Passer par le proxy
public ferait sortir puis rentrer la requête pour rien, et obligerait à exposer
un endpoint sans authentification.

`p256dh` et `auth` sont les clés de la `PushSubscription` du navigateur ; la
passerelle en a besoin pour chiffrer le push (sans elles, elle rejette la
pushkey —).

### `SYNAPSE_IP_RANGE_WHITELIST` n'est pas facultatif ici

C'est **Synapse** qui appelle la passerelle, et l'URL du pusher est un nom du
réseau du compose : elle résout vers une adresse privée. Le client HTTP sortant
de Synapse applique `ip_range_blacklist`, qui contient `172.16.0.0/12` par
défaut. Liste vide ⇒ Synapse n'appelle jamais `push-gateway`, et **rien ne le
dit** : le pusher est bien enregistré sur le compte, l'application annonce des
notifications actives, aucune n'arrive.

C'est le même blocage que le 503 muet du login OIDC, sur le second client
sortant de Synapse. [`infra/.env.example`](.env.example) livre donc `["172.16.0.0/12"]`, et le
garde-fou reste le même : ne pas activer `url_preview_enabled` tant que cette
liste n'est pas vide.

### Vérifier que la chaîne est branchée, sans téléphone

Les quatre maillons se lisent séparément, et dans cet ordre :

1. **la clé publique sort** — `curl -sk https://<SERVER_NAME>/push/config` rend
   `{"vapid_public_key":"…"}` ;
2. **le pusher est sur le compte** — `GET /_matrix/client/v3/pushers` avec le
   jeton de l'utilisateur contient une entrée `app_id: org.tacita.web` dont
   `data.url` pointe sur `push-gateway`. L'écran Profil › Réglages ›
   Notifications affiche la même chose en clair, maillon par maillon ;
3. **Synapse appelle la passerelle** — après un message reçu,
   `docker compose logs push-gateway` porte une ligne `push_ok` ou
   `push_failed`. **Aucune ligne** signifie que Synapse n'a pas appelé : c'est
   la liste ci-dessus, ou une push rule qui coupe (Profil › Réglages ›
   Notifications, niveau de la conversation) ;
4. **le service push a accepté** — `push_ok {"status":201}`. Un `push_failed`
   porte le code : `410`/`404` = subscription morte (Synapse supprime le pusher,
   l'application s'en réenregistre un à la prochaine ouverture), `403` = clé
   VAPID désaccordée entre la passerelle et l'abonnement du navigateur,
   `400` = `VAPID_SUBJECT` refusé par le service push (Apple exige un `mailto:`
   ou un `https:` réel).

Aucune de ces lignes ne porte de contenu : des identifiants et des codes de
statut, comme l'exige.

## service de liens d'invitation

Le service de `invite-tokens` est construit et démarré par ce compose, par la même
jurisprudence que la passerelle push : `invite-tokens` livre le code le
provisionne. Il est joignable **sous `/invite/`**, par le proxy, et nulle part
ailleurs — aucun port publié. Ses quatre routes exigent chacune un jeton d'accès
Matrix valide.

**Aucun secret d'administration Synapse dans son environnement**, et un test le
vérifie ([`tests/invite-tokens.test.ts`](tests/invite-tokens.test.ts)). C'est le point : `invite-tokens` borne les
dégâts d'une compromission en ne lui donnant aucun pouvoir Matrix, et le
raccordement est précisément l'endroit où on le lui rendrait par confort. Il
joint Synapse par le nom du réseau du compose (`http://synapse:8008`) — passer
par le proxy TLS rejouerait les quatre causes du 503 OIDC ci-dessous.

**Base dédiée `invite_tokens`**, jamais une table dans celle de Synapse. Elle est
créée par [`postgres/10-invite-tokens.sh`](postgres/10-invite-tokens.sh), monté dans
`/docker-entrypoint-initdb.d/` — donc **uniquement à la première initialisation du
volume**. Sur une pile déjà démarrée :

```sh
docker compose exec postgres createdb -U "$POSTGRES_USER" invite_tokens
```

Le schéma, lui, est créé par le service à son démarrage (`CREATE TABLE IF NOT
EXISTS`) : rien à dérouler à la main.

## Login OIDC — trois causes qui l'empêchent en local, une non résolue

Trouvé en montant la cible de fumée (arbitrage PM, point 9). **Le flux de login n'avait
jamais été exécuté** : les tests de assertent que le YAML déclare le provider
et désactive les mots de passe, pas qu'une connexion aboutit. Elle n'aboutit pas.

Symptôme unique et trompeur pour les trois causes : `GET /_matrix/client/v3/login/sso/redirect/…`
répond **503 « Authentication failed »**, et les logs ne montrent qu'un `OidcDiscoveryError`.
Synapse lit la découverte OIDC sur `https://${SERVER_NAME}/auth/realms/tacita/…`, donc il doit
joindre le proxy par le nom public.

1. **Le nom ne résout pas depuis le réseau Docker.** Corrigé par un alias réseau sur le proxy
   (`smoke/docker-compose.yml`).
2. **Synapse bloque ses propres requêtes vers les plages privées.** `ip_range_blacklist` contient
   `172.16.0.0/12` par défaut, et l'alias fait résoudre le nom vers le proxy, qui y est. D'où le
   réglage `SYNAPSE_IP_RANGE_WHITELIST`, **vide par défaut** : la protection reste entière tant que
   le déploiement n'en a pas besoin. Le symptôme du blocage est un timeout muet, rien dans les logs
   ne mentionne le blocage.
3. **Le certificat auto-signé n'était pas approuvé.** `SSL_CERT_FILE` ne suffit pas : c'est une
   convention du module `ssl` de Python, et le client HTTP de Synapse est **Twisted**, qui charge sa
   racine de confiance depuis le magasin OpenSSL du système. Corrigé : le CA de dev est copié dans
   `/usr/local/share/ca-certificates/` puis `update-ca-certificates` **au démarrage, depuis
   l'overlay** (l'image de production n'est pas modifiée ; l'entrypoint d'origine est
   conservé, on ne fait que le précéder).
4. **Le certificat n'avait aucun `subjectAltName`.** Cause profonde, et la seule qui dépassait le
   login : `generate-dev-certs.sh` ne passait qu'un `/CN=`. `service_identity` — donc Twisted, donc
   Synapse — refuse un certificat sans SAN, et **tout navigateur moderne aussi, depuis 2017**. Le
   certificat de dev était donc inutilisable pour la PWA elle-même (contexte sécurisé),
   et [`.env.example`](.env.example) promettait déjà un SAN pour le nom que le RTC sert — ce que le script ne
   pouvait pas tenir. Corrigé : `-addext subjectAltName=…`, avec `call.<domaine>`. *(Il y avait
   alors un troisième nom, `TURN_DOMAIN` ; il a disparu le 26/08/2026 — le TURN s'annonce sous
   `SERVER_NAME`, que le certificat porte déjà.)*

**Vérification.** [`infra/smoke/login.smoke.test.ts`](smoke/login.smoke.test.ts) assère le 302 vers le realm Keycloak, sous un
`describe` nommé `` — c'est le critère de comportement demandé par le PM. Retirer l'une de
ces corrections le fait échouer avec « 503 = découverte OIDC injoignable ».

**Ce que ça dit pour la production**, indépendamment du dev : si le déploiement résout
`SERVER_NAME` vers une adresse interne (hairpin NAT absent, DNS split-horizon), les causes 1 et 2
s'appliquent telles quelles. Si `SERVER_NAME` résout publiquement, aucune des trois ne se pose.
**À trancher : quel est le mode de résolution visé ?**

## rate limiting

Défauts relevés dans la doc v1.155.0, configurés ici à ≥ 10× (voir
[`synapse/homeserver.yaml.tmpl`](synapse/homeserver.yaml.tmpl) pour les valeurs exactes et leurs commentaires
en regard de chaque défaut).

## Rendu des templates

- `synapse/homeserver.yaml.tmpl` : l'image officielle Synapse ne fait que
  vérifier l'existence du fichier de config, elle ne substitue aucune
  variable — [`synapse/entrypoint.sh`](synapse/entrypoint.sh) rend le template via `envsubst` au
  démarrage du conteneur.
- `keycloak/realm-export.json` : Keycloak substitue nativement les
  `${VAR}` d'un realm importé à partir de son propre environnement (pas de
  rendu maison nécessaire), voir la doc Keycloak « Import/Export ».

## OIDC / Keycloak

Synapse ne gère pas plusieurs méthodes d'auth nativement : `password_config.enabled: false`,
seul le provider OIDC `keycloak` est actif. Le realm importé active WebAuthn
« passwordless » (authentificateur de plateforme, résident key requise) comme
required action optionnelle — l'utilisateur peut l'activer depuis son compte
Keycloak.
