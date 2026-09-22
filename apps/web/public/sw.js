/*
 * REQ-UI-01 — service worker de **coquille applicative**, et rien d'autre.
 *
 * Interdit n°8 : aucun contenu déchiffré dans le cache du service worker, y compris en
 * développement. Ici, la règle est tenue par construction plutôt que par vigilance :
 *
 *  - le précache est une **liste close** de routes de coquille, écrite ci-dessous ;
 *  - le `fetch` ne met en cache **que** ce qui vient de `/_next/static/` — les assets
 *    versionnés par le build, qui ne peuvent pas contenir de données utilisateur ;
 *  - tout le reste passe au réseau sans jamais être écrit.
 *
 * Une réponse de `/_matrix/…` n'a donc aucun chemin vers le cache : ce n'est pas une
 * précaution, c'est qu'aucune branche ne l'y mène.
 */
const VERSION = "tacita-coquille-v1";

/** La coquille : des routes vides et le manifeste. Zéro donnée utilisateur. */
const COQUILLE = ["/", "/recherche", "/mentions", "/profil", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(COQUILLE)));
});

self.addEventListener("activate", (event) => {
  // Les caches d'une version précédente contiennent une coquille périmée : elle ferait
  // tourner du code qui n'est plus celui de l'app.
  event.waitUntil(
    caches
      .keys()
      .then((noms) => Promise.all(noms.filter((nom) => nom !== VERSION).map((nom) => caches.delete(nom)))),
  );
});

self.addEventListener("fetch", (event) => {
  const requete = event.request;
  const url = new URL(requete.url);
  const memeOrigine = url.origin === self.location.origin;

  // Seuls les assets versionnés du build entrent au cache. Le test de REQ-UI-01 relit
  // cette condition : l'élargir est ce qui ferait entrer des données utilisateur.
  const cachable = memeOrigine && requete.method === "GET" && url.pathname.startsWith("/_next/static/");

  if (cachable) {
    event.respondWith(
      caches.match(requete).then(
        (enCache) =>
          enCache ??
          fetch(requete).then((reponse) => {
            if (reponse.ok) {
              const copie = reponse.clone();
              void caches.open(VERSION).then((cache) => cache.put(requete, copie));
            }
            return reponse;
          }),
      ),
    );
    return;
  }

  // REQ-UI-17 — hors ligne, une navigation retombe sur la coquille précachée : l'app
  // s'ouvre et lit son historique local au lieu d'afficher le dinosaure du navigateur.
  if (requete.mode === "navigate") {
    event.respondWith(fetch(requete).catch(() => caches.match("/").then((r) => r ?? Response.error())));
  }
});

/*
 * REQ-UI-18 / REQ-UIX-40 — le réveil par notification.
 *
 * Le payload porte `{event_id, room_id, sender, sender_display_name}` (REQ-PSH-02, amendée
 * E-12) : ce worker ne reçoit aucun contenu, et n'a aucun moyen d'en produire seul — les clés
 * Megolm vivent dans le magasin crypto ouvert par l'onglet. Il demande donc l'aperçu à
 * l'application (`lib/notifications.ts`), et affiche « Nouveau message de X » quand personne
 * ne peut répondre.
 *
 * Ce chemin **n'écrit rien** : ni cache, ni IndexedDB, ni journal. L'aperçu ne fait que
 * traverser, du port de message à `showNotification`.
 */
const CANAL_PUSH = "tacita:push";

/** Au-delà, l'onglet ne répondra pas : notification générique plutôt que rien du tout. */
const DELAI_APERCU_MS = 2000;

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    // Payload illisible : on notifie quand même, sans rien en dire. Le journaliser
    // reviendrait à écrire un contenu inconnu dans les logs du navigateur.
  }
  event.waitUntil(afficherNotification(payload));
});

async function afficherNotification({ event_id, room_id, sender, sender_display_name }) {
  const apercu = event_id && room_id ? await demanderApercu({ event_id, room_id }) : null;

  await self.registration.showNotification(apercu ? apercu.titre : titreDeRepli(sender, sender_display_name), {
    body: apercu ? apercu.corps : undefined,
    // Groupées par conversation : dix messages d'une même personne remplacent la
    // notification précédente au lieu d'empiler dix lignes.
    tag: room_id ?? "tacita",
    // Sans lui, le remplacement par tag est silencieux : le deuxième message d'une
    // conversation n'alerterait plus.
    renotify: true,
    data: { room_id },
  });
  await majBadge();
}

/**
 * REQ-PSH-02 (amendée E-12) — quand personne ne peut déchiffrer (application fermée, cas
 * nominal sur iOS), l'expéditeur relayé par la passerelle donne au moins « de qui ». Nom
 * d'affichage d'abord, sinon la partie locale de l'identifiant (`@ana:serveur` → `ana`).
 * Jamais de texte : il n'y en a pas dans le payload.
 */
function titreDeRepli(sender, nomAffiche) {
  const nom =
    (typeof nomAffiche === "string" && nomAffiche) ||
    (typeof sender === "string" && sender.startsWith("@") ? sender.slice(1).split(":")[0] : "");
  return nom ? `Nouveau message de ${nom}` : "Nouveau message";
}

/**
 * Le badge de l'icône suit les notifications affichées : il monte avec elles, et
 * retombe quand on les ferme (tap ici, ouverture de la conversation côté app).
 *
 * ponytail: compte les conversations qui ont une notification en attente, pas les
 * messages non lus — le payload ne porte pas le compteur de Synapse (REQ-PSH-02).
 * Relayer `counts.unread` le jour où le nombre exact compte.
 *
 * Un badge qui échoue ne doit jamais empêcher la notification : erreurs avalées, et
 * rien de journalisé.
 */
async function majBadge() {
  try {
    const navigateur = self.navigator;
    if (!navigateur?.setAppBadge || !self.registration.getNotifications) return;
    const affichees = await self.registration.getNotifications();
    await (affichees.length > 0 ? navigateur.setAppBadge(affichees.length) : navigateur.clearAppBadge());
  } catch {
    // Badging API absente ou refusée : la notification est déjà là, c'est l'essentiel.
  }
}

function demanderApercu(payload) {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const onglet = clients[0];
    if (!onglet) return null;

    return new Promise((resolve) => {
      const canal = new MessageChannel();
      const minuteur = setTimeout(() => resolve(null), DELAI_APERCU_MS);
      canal.port1.onmessage = (message) => {
        clearTimeout(minuteur);
        resolve(message.data ?? null);
      };
      // Le port de réponse est privé : l'aperçu déchiffré ne part pas en diffusion.
      onglet.postMessage({ type: CANAL_PUSH, ...payload }, [canal.port2]);
    });
  });
}

// REQ-UI-18 — tap → la conversation. Un onglet déjà ouvert est repris plutôt que doublé.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const cible = event.notification.data?.room_id ? `/c/${event.notification.data.room_id}` : "/";

  event.waitUntil(
    majBadge().then(() =>
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        const onglet = clients[0];
        if (!onglet) return self.clients.openWindow(cible);
        // `navigate` n'existe que sur un client contrôlé par ce worker : sans lui, on
        // ramène au moins l'onglet au premier plan.
        return Promise.resolve(onglet.navigate ? onglet.navigate(cible) : undefined)
          .catch(() => undefined)
          .then(() => onglet.focus());
      }),
    ),
  );
});
