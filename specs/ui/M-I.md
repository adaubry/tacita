# M-I — Appels et notifications push

**Dépendances : M-A, packages calls (spec 10) et client-core (04) ; passerelle push (spec 03). Escalation E-07 : l'UI en appel appartient à Element Call.**

## Livrable

Intégration des appels (shell autour du widget Element Call) et chaîne de notifications push côté client.

## Exigences

### Appels
- **REQ-UI-19** — Boutons appel audio / appel vidéo (icônes seules) dans le header de conversation (M-D fournit l'emplacement, M-I le comportement) ; tap → conteneur plein écran embarquant le widget Element Call (`buildCallWidget`, spec 10) ; bandeau persistant « Appel en cours — rejoindre » dans les salons concernés (REQ-CAL-03) ; erreur `RtcFociMissing` → message d'erreur explicite, jamais de bouton inerte.
- **REQ-UIX-38** — Shell d'appel minimal : notre UI ne rend que le conteneur (plein écran, safe-areas) et un bouton de sortie de secours si le widget ne charge pas (timeout → message + retour). Bascule voix↔vidéo, layout vidéo, auto-masquage des menus : **comportements internes d'Element Call, hors périmètre** (E-07). Le point d'entrée « appel audio » vs « appel vidéo » passe les paramètres de lancement correspondants au widget.
- **REQ-UIX-39** — Entrée « Appel audio » des Friends interaction buttons (M-G) → même chemin que le header 1:1.

### Notifications
- **REQ-UI-18** — Abonnement Web Push : clé VAPID récupérée (spec 03), permission demandée au bon moment (après le premier message reçu ou depuis les réglages — jamais au premier lancement) ; réveil SW → payload {event_id, room_id, sender, sender_display_name} → récupération et **déchiffrement local** → notification affichée (expéditeur + aperçu déchiffrés localement **quand l'application est ouverte** ; sinon « Nouveau message de X », expéditeur relayé et aucun aperçu — amendé le 22/09/2026, arbitrage E-12) ; tap → conversation, et ouvrir une conversation ferme ses notifications et remet le badge au compte. Sur refus de permission : état visible dans les réglages avec chemin de rattrapage.
- **REQ-UIX-40** — Le SW de notification ne persiste rien : aucun contenu déchiffré en cache SW, aucun payload loggé (interdits CLAUDE.md) ; si le déchiffrement échoue (clés absentes, application fermée), notification générique « Nouveau message » — « Nouveau message de X » quand le payload porte l'expéditeur — sans contenu, sans erreur bruyante.

## Contraintes

- L'iframe Element Call reçoit uniquement les permissions nécessaires (`allow="camera; microphone; fullscreen"`).
- Notifications groupées par conversation (tag) pour éviter l'empilement.

## Hors scope

Infra LiveKit/TURN (spec 02), passerelle (spec 03), logique widget (package 10) ; éducation iOS (M-B).

## Objectif mesurable

Vitest + Testing Library, packages mockés : REQ-UI-19 (RtcFociMissing → message rendu ; état appel actif → bandeau) ; REQ-UIX-38 (timeout de chargement → sortie de secours ; paramètres audio vs vidéo transmis) ; REQ-UI-18 (payload mocké → notification construite à partir de l'événement déchiffré localement — spy sur l'API Notification) ; REQ-UIX-40 (échec de déchiffrement → notification générique ; spy logger/cache : zéro contenu).
