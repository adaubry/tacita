# Passerelle Web Push

Service Node autonome qui implémente l'interface Matrix Push Gateway et relaie
les notifications de Synapse vers les navigateurs en **Web Push standard
(VAPID)**. Sygnal ne couvre qu'APNs et FCM : pour une PWA auto-hébergée, il
fallait cette passerelle.

**Limites assumées ci-dessous, à lire avant d'intégrer côté client.**

## Endpoints

| Méthode | Chemin | Rôle |
| --- | --- | --- |
| `POST` | `/_matrix/push/v1/notify` | Appelé par Synapse. Répond `{"rejected": [pushkeys]}` — Synapse supprime les pushers listés. |
| `GET` | `/config` | `{"vapid_public_key": "..."}` pour l'abonnement client. |

Le payload envoyé au navigateur contient **exactement** `event_id`, `room_id`,
`sender` et `sender_display_name`. Aucun contenu : le serveur n'en a pas, et le client
déchiffre localement au réveil. L'expéditeur est une métadonnée que Synapse connaît
déjà ; il sert de repli (« Nouveau message de X ») quand l'application est fermée.

## Limites assumées

- **Sur iOS, rien ne fonctionne hors PWA installée.** Safari ne délivre de Web Push
  qu'à une application ajoutée à l'écran d'accueil ; un onglet ordinaire n'en reçoit
  aucune, et aucun réglage ne le change.
- **La notification ne peut rien dire du message.** La passerelle n'a pas les clés
  Megolm, et le service worker n'en a pas non plus quand l'application est fermée. Une
  notification à froid dit qui écrit, jamais quoi — voir [`apps/web`](../web).
- **La passerelle reçoit l'événement complet.** Synapse n'a pas de format « expéditeur
  seul » : sans `event_id_only`, il envoie l'événement entier — contenu **chiffré**, nom
  du salon, compteurs. La passerelle n'en relaie que les quatre champs ci-dessus et n'en
  journalise aucun.
- **Un push perdu n'est pas retenté.** Pas de base, pas de file d'attente : la reprise
  est le `/sync` suivant, qui redescend l'événement de toute façon.
- **Une rotation des clés VAPID invalide toutes les subscriptions existantes.** Chaque
  navigateur doit se réabonner, et un pusher qui pointe l'ancienne clé échoue en silence
  jusque-là.
- **Un pusher sans `p256dh`/`auth` est inutilisable** : la passerelle le renvoie
  immédiatement dans `rejected`, et Synapse le supprime.

## Clés VAPID

Générées **une fois au déploiement**, jamais commitées :

```sh
pnpm --filter push-gateway exec web-push generate-vapid-keys
```

Une rotation invalide toutes les subscriptions existantes.

## Démarrage

```sh
VAPID_SUBJECT=mailto:admin@example.org \
VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... PORT=8008 \
pnpm --filter push-gateway start
```

## Contrat d'enregistrement du pusher (côté client)

`POST /_matrix/client/v3/pushers` avec `kind: "http"`, `pushkey` = l'endpoint
Web Push, et dans `data` : `url` (celle de cette passerelle) — **pas** de `format:
"event_id_only"`, qui retirerait l'expéditeur — et les clés de la subscription :

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
notifications : `apps/web`.
