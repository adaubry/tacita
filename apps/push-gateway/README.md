# Passerelle Web Push (spec 03)

Service Node autonome qui implémente l'interface Matrix Push Gateway et relaie
les notifications de Synapse vers les navigateurs en **Web Push standard
(VAPID)**. Sygnal ne couvre qu'APNs et FCM : pour une PWA auto-hébergée, il
fallait cette passerelle.

Limites assumées : `LIMITES.md` — **à lire avant d'intégrer côté client**
(sur iOS, rien ne fonctionne hors PWA installée).

## Endpoints

| Méthode | Chemin | Rôle |
| --- | --- | --- |
| `POST` | `/_matrix/push/v1/notify` | Appelé par Synapse. Répond `{"rejected": [pushkeys]}` — Synapse supprime les pushers listés. |
| `GET` | `/config` | `{"vapid_public_key": "..."}` pour l'abonnement client (spec 11). |

Le payload envoyé au navigateur contient **exactement** `event_id` et
`room_id`. Aucun contenu, aucun expéditeur : le serveur n'en a pas, et le
client déchiffre localement au réveil.

## Clés VAPID

Générées **une fois au déploiement**, jamais commitées :

```sh
pnpm --filter push-gateway exec web-push generate-vapid-keys
```

Une rotation invalide toutes les subscriptions existantes (voir `LIMITES.md`).

## Démarrage

```sh
VAPID_SUBJECT=mailto:admin@example.org \
VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... PORT=8008 \
pnpm --filter push-gateway start
```

## Contrat d'enregistrement du pusher (côté client, spec 11)

`POST /_matrix/client/v3/pushers` avec `kind: "http"`, `pushkey` = l'endpoint
Web Push, et dans `data` : `url` (celle de cette passerelle) et les clés de la
subscription. **Pas de `format: "event_id_only"`** (REQ-PSH-02, amendée E-12) : il
retirait aussi l'expéditeur. La passerelle reçoit l'événement complet et n'en relaie
que `event_id`, `room_id`, `sender` et `sender_display_name` :

```json
{
  "kind": "http",
  "app_id": "org.tacita.web",
  "pushkey": "https://push.services.mozilla.com/wpush/v2/...",
  "data": {
    "url": "https://push.tacita.chat/_matrix/push/v1/notify",
    "p256dh": "<subscription.keys.p256dh>",
    "auth": "<subscription.keys.auth>"
  }
}
```

Un pusher sans `p256dh`/`auth` est inutilisable : la passerelle le renvoie
immédiatement dans `rejected`.

## Non couvert ici

Abonnement navigateur, demande de permission, affichage et déchiffrement des
notifications : spec 11. Pas de base de données, pas de file d'attente — un
push perdu est rattrapé par le `/sync` suivant.
