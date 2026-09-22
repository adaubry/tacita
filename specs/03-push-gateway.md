# SPEC 03 — Passerelle Web Push (VAPID)

**Package : `apps/push-gateway/`. Dépendances : spec 01 (Synapse comme source des pushes). Service Node autonome.**

## Livrable

Passerelle push maison implémentant l'interface Matrix Push Gateway (`POST /_matrix/push/v1/notify`) et relayant en **Web Push standard avec VAPID** vers les navigateurs. Justification : Sygnal ne gère qu'APNs et FCM, pas le Web Push standard — indispensable pour une PWA auto-hébergée sans service tiers.

## Exigences et critères d'acceptation

- **REQ-PSH-01** — Endpoint `/_matrix/push/v1/notify` conforme à la spec Push Gateway : accepte le payload Synapse, répond avec la liste `rejected` des subscriptions mortes (404/410 du push service → rejetée, pour que Synapse supprime le pusher).
- **REQ-PSH-02** — Payload envoyé au navigateur : **uniquement** `event_id`, `room_id`, et l'identité de l'expéditeur (`sender`, `sender_display_name`). Jamais de contenu, jamais de texte, jamais de nom de salon. Le client déchiffre localement (spec 11) après réveil ; l'expéditeur sert au repli quand il ne le peut pas (application fermée).
  *Amendée le 22/09/2026 (arbitrage PM de E-12) — la version initiale excluait aussi le nom d'expéditeur.* Motif : sur iOS le cas nominal du push est l'application fermée, où rien ne peut être déchiffré, et « Nouveau message » seul était remonté comme un défaut par les testeurs. L'expéditeur n'est pas du contenu : Synapse le connaît en clair pour chaque événement, et le payload Web Push est chiffré pour l'appareil (RFC 8291) — le push service ne le lit pas. Contrepartie : Synapse n'a pas de format « expéditeur seul », le pusher passe donc en format complet et la passerelle reçoit l'événement entier, contenu **chiffré** compris ; elle n'en relaie que ces quatre champs et n'en journalise aucun (REQ-PSH-04).
- **REQ-PSH-03** — Clés VAPID générées au déploiement, clé publique exposée sur un endpoint de config pour l'abonnement client.
- **REQ-PSH-04** — Aucun contenu utilisateur ni payload entrant dans les logs de la passerelle, y compris en dev : seuls des IDs et codes de statut sont loggés.
- **REQ-PSH-05** — Doc `LIMITES.md` : sur iOS, le Web Push exige la PWA ajoutée à l'écran d'accueil ; un utilisateur restant dans Safari ne recevra jamais de notification. (L'UI porte cette contrainte, spec 11 ; ce module la documente.)

## Méthode et contraintes

- Node + `web-push` (lib standard). Pas de file persistante, pas de retry sophistiqué : un push perdu est rattrapé par le /sync suivant (YAGNI).
- Stockage des subscriptions : la subscription complète est fournie par Synapse dans les données du pusher à chaque notify — pas de base de données propre si évitable ; sinon SQLite, rien de plus.
- Hors scope : abonnement côté client, permission navigateur, affichage des notifications (spec 11).

## Objectif mesurable

Suite Vitest avec `web-push` mocké : REQ-PSH-01 (payload Synapse valide → push émis ; push service répond 410 → subscription dans `rejected`) ; REQ-PSH-02 (assertion structurelle : le payload sortant a exactement les clés `event_id`, `room_id`, `sender`, `sender_display_name` — ni contenu, ni nom de salon) ; REQ-PSH-04 (spy sur le logger : aucun champ de contenu ne transite). Une describe par REQ, nommée par son ID.
