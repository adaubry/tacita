# Limites assumées — passerelle push (spec 03)

Documentées, jamais masquées (spec 00 — Honnêteté produit).

- **iOS : notifications uniquement si la PWA est ajoutée à l'écran d'accueil.**
  Le Web Push n'est disponible sur iOS que pour une application web installée
  via « Sur l'écran d'accueil ». Un utilisateur qui reste dans **Safari** ne
  recevra **jamais** de notification, quel que soit l'état de la passerelle :
  il n'y a ni contournement ni repli. L'UI doit porter cette contrainte
  explicitement (spec 11) ; ce module ne fait que la documenter.
- **Aucune garantie de livraison.** Pas de file persistante, pas de retry : si
  le push service est indisponible, la notification est perdue. Le message,
  lui, ne l'est pas — il arrive au `/sync` suivant. La notification est un
  confort, pas un canal de transport.
- **La notification ne contient aucun texte.** Le payload transporte
  `event_id`, `room_id` et l'expéditeur (`sender`, `sender_display_name`)
  seulement (REQ-PSH-02, amendée E-12) : le serveur ne voit jamais de clair,
  donc il ne peut mettre aucun aperçu dans la notification. L'aperçu affiché
  dépend du déchiffrement local au réveil du service worker ; s'il échoue
  (application fermée, clés absentes), la notification dit seulement de qui
  vient le message.
- **La passerelle reçoit l'événement complet de Synapse.** Depuis E-12, le
  pusher n'est plus en `event_id_only` — ce format retirait aussi l'expéditeur,
  et Synapse n'en a pas d'intermédiaire. La passerelle reçoit donc le contenu
  **chiffré** de l'événement, le nom du salon et les compteurs. Elle ne relaie
  au navigateur que les quatre champs ci-dessus, et ne journalise rien du corps
  reçu (REQ-PSH-04). L'expéditeur relayé est une métadonnée que Synapse connaît
  déjà ; le payload Web Push est chiffré pour l'appareil (RFC 8291), le push
  service ne le lit pas.
- **Métadonnées visibles par le push service.** Mozilla, Google ou Apple, selon
  le navigateur, voient l'endpoint sollicité et l'horodatage de chaque push —
  donc la fréquence et les moments d'activité, sans le contenu.
- **Rotation des clés VAPID = réabonnement de tous les clients.** Changer la
  paire invalide toutes les subscriptions existantes ; elles remonteront en
  `rejected` et devront être recréées par chaque navigateur.
