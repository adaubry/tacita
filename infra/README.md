# infra — socle serveur (spec 01)

Config-as-code : PostgreSQL, Synapse, Keycloak (OIDC + WebAuthn), MinIO (S3),
reverse proxy nginx, et le **raccordement** de deux services livrés ailleurs — la
passerelle Web Push (REQ-INF-14) et le service de liens d'invitation (REQ-INF-15).
Hors scope : LiveKit/TURN/well-known (spec 02), le *code* de la passerelle push
(spec 03) et celui du service de liens (spec 12).

## Démarrage

```sh
cp .env.example .env        # remplir les secrets
./proxy/generate-dev-certs.sh   # certs auto-signés, dev uniquement
docker compose up -d
```

Création d'un compte (REQ-INF-04 — inscription fermée) :

```sh
docker compose exec synapse register_new_matrix_user \
  -c /data/homeserver.yaml http://localhost:8008
```

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

## REQ-INF-12 — authenticated media (Synapse v1.155.0)

Vérifié dans le changelog Synapse : `enable_authenticated_media` est passé à
`true` par défaut en **v1.139.0** (2024-09), et depuis **v1.146.0** les
anciens endpoints non authentifiés (`/_matrix/media/v3/download`,
`/_matrix/media/v3/thumbnail`) répondent **404** — ils ne sont plus un simple
fallback dépréciés mais deux voies mortes.

Conséquence pour le client (spec 08, spec 11) : tout accès média — y compris
le téléchargement du blob chiffré opaque — doit passer par les endpoints
authentifiés (`/_matrix/client/v1/media/download/{serverName}/{mediaId}` et
variante thumbnail) avec l'access token en en-tête. Aucune URL média publique
ne doit être supposée. (Rappel : les vignettes de média chiffré ne sont de
toute façon jamais demandées au serveur — REQ-MED-03, spec 08.)

## REQ-INF-14 — passerelle Web Push

Le service de la spec 03 est construit et démarré par ce compose. Il n'a **aucun
port publié** : `/_matrix/push/v1/notify` n'a pas d'authentification (la
subscription complète arrive dans le payload de Synapse), et le publier sur
l'hôte ferait de la passerelle un relais de push ouvert. Seule sort la clé
publique VAPID, par le proxy.

**Ce que le client (spec 11) doit faire :**

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
pushkey — REQ-PSH-01).

## REQ-INF-15 — service de liens d'invitation

Le service de la spec 12 est construit et démarré par ce compose, par la même
jurisprudence que la passerelle push : la spec 12 livre le code, la spec 01 le
provisionne. Il est joignable **sous `/invite/`**, par le proxy, et nulle part
ailleurs — aucun port publié. Ses quatre routes exigent chacune un jeton d'accès
Matrix valide.

**Aucun secret d'administration Synapse dans son environnement**, et un test le
vérifie (`tests/invite-tokens.test.ts`). C'est le point : la spec 12 borne les
dégâts d'une compromission en ne lui donnant aucun pouvoir Matrix, et le
raccordement est précisément l'endroit où on le lui rendrait par confort. Il
joint Synapse par le nom du réseau du compose (`http://synapse:8008`) — passer
par le proxy TLS rejouerait les quatre causes du 503 OIDC ci-dessous.

**Base dédiée `invite_tokens`**, jamais une table dans celle de Synapse. Elle est
créée par `postgres/10-invite-tokens.sh`, monté dans
`/docker-entrypoint-initdb.d/` — donc **uniquement à la première initialisation du
volume**. Sur une pile déjà démarrée :

```sh
docker compose exec postgres createdb -U "$POSTGRES_USER" invite_tokens
```

Le schéma, lui, est créé par le service à son démarrage (`CREATE TABLE IF NOT
EXISTS`) : rien à dérouler à la main.

## Login OIDC — trois causes qui l'empêchent en local, une non résolue

Trouvé en montant la cible de fumée (arbitrage PM, point 9). **Le flux de login n'avait
jamais été exécuté** : les tests de REQ-INF-09 assertent que le YAML déclare le provider
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
   l'overlay** (D-07 — l'image de production n'est pas modifiée ; l'entrypoint d'origine est
   conservé, on ne fait que le précéder).
4. **Le certificat n'avait aucun `subjectAltName`.** Cause profonde, et la seule qui dépassait le
   login : `generate-dev-certs.sh` ne passait qu'un `/CN=`. `service_identity` — donc Twisted, donc
   Synapse — refuse un certificat sans SAN, et **tout navigateur moderne aussi, depuis 2017**. Le
   certificat de dev était donc inutilisable pour la PWA elle-même (REQ-INF-10, contexte sécurisé),
   et `.env.example` promettait déjà que `TURN_DOMAIN` soit « un SAN du certificat monté » — ce que
   le script ne pouvait pas tenir. Corrigé : `-addext subjectAltName=…`, avec `TURN_DOMAIN` quand il
   est défini.

**Vérification.** `infra/smoke/login.smoke.test.ts` assère le 302 vers le realm Keycloak, sous un
`describe` nommé `REQ-INF-09` — c'est le critère de comportement demandé par le PM. Retirer l'une de
ces corrections le fait échouer avec « 503 = découverte OIDC injoignable ».

**Ce que ça dit pour la production**, indépendamment du dev : si le déploiement résout
`SERVER_NAME` vers une adresse interne (hairpin NAT absent, DNS split-horizon), les causes 1 et 2
s'appliquent telles quelles. Si `SERVER_NAME` résout publiquement, aucune des trois ne se pose.
**À trancher : quel est le mode de résolution visé ?**

## REQ-INF-05 — rate limiting

Défauts relevés dans la doc v1.155.0, configurés ici à ≥ 10× (voir
`synapse/homeserver.yaml.tmpl` pour les valeurs exactes et leurs commentaires
en regard de chaque défaut).

## Rendu des templates

- `synapse/homeserver.yaml.tmpl` : l'image officielle Synapse ne fait que
  vérifier l'existence du fichier de config, elle ne substitue aucune
  variable — `synapse/entrypoint.sh` rend le template via `envsubst` au
  démarrage du conteneur.
- `keycloak/realm-export.json` : Keycloak substitue nativement les
  `${VAR}` d'un realm importé à partir de son propre environnement (pas de
  rendu maison nécessaire), voir la doc Keycloak « Import/Export ».

## REQ-INF-09 — OIDC / Keycloak

Synapse ne gère pas plusieurs méthodes d'auth nativement : `password_config.enabled: false`,
seul le provider OIDC `keycloak` est actif. Le realm importé active WebAuthn
« passwordless » (authentificateur de plateforme, résident key requise) comme
required action optionnelle — l'utilisateur peut l'activer depuis son compte
Keycloak.
