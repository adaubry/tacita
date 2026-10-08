/*
 * service worker de **coquille applicative**, et rien d'autre.
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
const VERSION = "tacita-coquille-v2";

/**
 * La coquille : des routes vides et le manifeste. Zéro donnée utilisateur.
 *
 * `/c` et `/c/infos` en font partie depuis le 08/08/2026 : ce sont les écrans de
 * conversation, et le salon y voyage en `?room=` (voir `lib/routes.ts`). Tant qu'il était
 * un segment de chemin, il n'y avait rien à précacher — un salon par URL, et hors ligne
 * aucune conversation ne s'ouvrait. Ces coquilles sont vides : l'identifiant du salon est
 * dans l'URL demandée, jamais dans ce qui est mis en cache.
 */
const COQUILLE = ["/", "/c", "/c/infos", "/recherche", "/mentions", "/profil", "/manifest.webmanifest"];

/*
 * `skipWaiting` + `claim` — **une PWA installée ne ferme jamais tous ses onglets.**
 *
 * Sans eux, un worker corrigé reste « en attente » indéfiniment : la correction est
 * livrée, personne ne la reçoit. C'est particulièrement vrai du handler `push`, qui est
 * la seule chose que l'utilisateur ne peut ni voir ni relancer lui-même.
 *
 * Le risque habituel de ce couple — une page servie à moitié par l'ancien worker et à
 * moitié par le nouveau — n'existe pas ici : le seul chemin de cache porte sur
 * `/_next/static/`, dont les URL sont versionnées par le build.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(COQUILLE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  // Les caches d'une version précédente contiennent une coquille périmée : elle ferait
  // tourner du code qui n'est plus celui de l'app.
  event.waitUntil(
    caches
      .keys()
      .then((noms) => Promise.all(noms.filter((nom) => nom !== VERSION).map((nom) => caches.delete(nom))))
      .then(() => self.clients.claim()),
  );
});

/**
 * (b) — le préfixe des URL virtuelles de lecture progressive.
 *
 * **Ce worker ne déchiffre rien et ne détient aucune clé.** Il demande les octets à une
 * fenêtre vivante, qui vérifie le bloc et le déchiffre. C'est la forme la plus forte des
 * bornes prévues : le handler `push` ne peut pas lire une table de clés qui n'existe pas,
 * et un worker réveillé à froid par une notification n'a personne à qui demander — il
 * répond 404 et ne sert pas un octet.
 */
const PREFIXE_MEDIA = "/tacita-media/";
const TYPE_PLAGE = "tacita-media-plage";
const DELAI_PLAGE_MS = 10_000;

/** `bytes=0-1048575` → `{ debut, fin }` ; `fin` reste nul quand la requête ne la borne pas. */
function plageDemandee(entete) {
  const trouve = /^bytes=(\d+)-(\d*)$/.exec(entete ?? "");
  if (!trouve) return null;
  return { debut: Number(trouve[1]), fin: trouve[2] === "" ? null : Number(trouve[2]) };
}

function demanderPlage(id, plage) {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((fenetres) => {
    const fenetre = fenetres[0];
    if (!fenetre) return null;

    return new Promise((resolve) => {
      const canal = new MessageChannel();
      const minuteur = setTimeout(() => resolve(null), DELAI_PLAGE_MS);
      canal.port1.onmessage = (message) => {
        clearTimeout(minuteur);
        resolve(message.data ?? null);
      };
      fenetre.postMessage({ type: TYPE_PLAGE, id, debut: plage.debut, fin: plage.fin }, [canal.port2]);
    });
  });
}

function servirMedia(requete, id) {
  const plage = plageDemandee(requete.headers.get("range")) ?? { debut: 0, fin: null };

  return demanderPlage(id, plage).then((reponse) => {
    // Aucune fenêtre, aucune inscription, ou une vérification d'intégrité qui a échoué :
    // rien n'est servi, et surtout jamais un octet non vérifié.
    if (!reponse || reponse.erreur || !reponse.octets) {
      return new Response(null, { status: 404, statusText: "media indisponible" });
    }

    return new Response(reponse.octets, {
      status: 206,
      headers: {
        "content-type": reponse.type,
        "content-length": String(reponse.octets.byteLength),
        "content-range": `bytes ${reponse.debut}-${reponse.fin}/${reponse.taille}`,
        "accept-ranges": "bytes",
        // Interdit n°8 — ce contenu est déchiffré : il ne va dans aucun cache, ni le nôtre,
        // ni celui du navigateur.
        "cache-control": "no-store",
      },
    });
  });
}

self.addEventListener("fetch", (event) => {
  const requete = event.request;
  const url = new URL(requete.url);
  const memeOrigine = url.origin === self.location.origin;

  // (b) — la lecture progressive, avant toute considération de cache : ce
  // chemin ne passe **jamais** par `caches`, ni en lecture ni en écriture.
  if (memeOrigine && url.pathname.startsWith(PREFIXE_MEDIA)) {
    event.respondWith(servirMedia(requete, url.pathname.slice(PREFIXE_MEDIA.length)));
    return;
  }

  // Seuls les assets versionnés du build entrent au cache. Le test de relit
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

  // hors ligne, une navigation retombe sur la coquille précachée : l'app
  // s'ouvre et lit son historique local au lieu d'afficher le dinosaure du navigateur.
  if (requete.mode === "navigate") {
    // `ignoreSearch` : `/c?room=!salon` doit retrouver la coquille précachée `/c`. Sans
    // lui, toute navigation portant un paramètre retombait sur `/` — l'accueil s'affichait
    // à l'URL d'une conversation, ce qui est la pire des deux réponses possibles.
    event.respondWith(
      fetch(requete).catch(() =>
        caches
          .match(requete, { ignoreSearch: true })
          .then((r) => r ?? caches.match("/"))
          .then((r) => r ?? Response.error()),
      ),
    );
  }
});

/*
 * les notifications.
 *
 * Le payload reçu porte `{event_id, room_id, sender, sender_display_name}` : des
 * métadonnées que le serveur connaît déjà, jamais de contenu — il n'en a pas à donner.
 * Le contenu, lui, se déchiffre **ici**, au sens de « sur
 * cet appareil » — mais pas dans ce fichier : les clés Megolm vivent dans le store
 * crypto d'une fenêtre, hors de portée du service worker. Une fenêtre ouverte est donc
 * interrogée, et c'est elle qui rend l'aperçu.
 *
 * Ce qui n'arrive à aucun moment (interdit n°8) : rien de tout cela n'entre au cache —
 * le `fetch` ci-dessus n'a pas de branche qui y mène —, rien n'est journalisé, et rien
 * ne survit à l'affichage de la notification. **Aucun `console` dans ce fichier**, pas
 * même en développement : un payload journalisé est un identifiant d'événement de plus
 * dans un journal que personne ne relit avant l'incident.
 */
const TYPE_APERCU = "tacita-apercu";

/** Au-delà, on considère qu'aucune fenêtre ne répondra — la notification part générique. */
const DELAI_APERCU_MS = 2000;

function demanderApercu(roomId, eventId) {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((fenetres) => {
    // Une seule fenêtre interrogée : un `MessagePort` ne se transfère qu'une fois, et
    // toutes partagent le même store crypto — la deuxième n'apprendrait rien de plus.
    const fenetre = fenetres[0];
    if (!fenetre) return null;

    return new Promise((resolve) => {
      const canal = new MessageChannel();
      const minuteur = setTimeout(() => resolve(null), DELAI_APERCU_MS);
      canal.port1.onmessage = (message) => {
        clearTimeout(minuteur);
        resolve(message.data ?? null);
      };
      fenetre.postMessage({ type: TYPE_APERCU, roomId, eventId }, [canal.port2]);
    });
  });
}

/**
 * Les options de toute notification affichée ici, au même endroit.
 *
 * `renotify` est le correctif le moins visible et le plus coûteux de la série : avec un
 * `tag` et **sans lui**, la deuxième notification d'une même conversation remplace la
 * première *en silence* — pas de son, pas de vibration, rien à l'écran verrouillé. Du
 * point de vue de l'utilisateur, les notifications « ne marchent plus » à partir du
 * deuxième message, ce qui est indiscernable d'une chaîne push cassée.
 *
 * `icon` et `badge` : sans eux, Android affiche un rond gris à la place de l'application.
 */
function optionsNotification(roomId, eventId, apercu) {
  return {
    body: apercu ? apercu.texte : "",
    icon: "/icone-192.png",
    badge: "/icone-192.png",
    // Groupées par conversation : un salon bavard remplace sa notification au lieu
    // d'en empiler une par message — mais il réalerte (voir `renotify`).
    tag: roomId,
    renotify: true,
    data: { roomId, eventId },
  };
}

/**
 * Le badge de l'icône suit les notifications affichées : il monte avec elles et retombe
 * quand on les ferme (tap ici, ouverture de la conversation côté app, `lib/push.ts`).
 *
 * ponytail: compte les conversations qui ont une notification en attente, pas les
 * messages non lus — le payload ne porte pas le compteur de Synapse. Relayer
 * `counts.unread` le jour où le nombre exact compte.
 *
 * Un badge qui échoue ne doit jamais empêcher la notification : erreurs avalées.
 */
/**
 * Sans aperçu (application fermée — le cas nominal sur iOS —, ou clés absentes), la
 * passerelle a relayé de qui vient le message : nom d'affichage, sinon la partie locale
 * de l'identifiant (`@ana:serveur` → `ana`). Jamais de texte : il n'y en a pas.
 */
function titreDeRepli(charge) {
  const nom = charge.sender_display_name || (charge.sender && charge.sender.slice(1).split(":")[0]);
  return nom ? `Nouveau message de ${nom}` : "Nouveau message";
}

function majBadge() {
  const navigateur = self.navigator;
  if (!navigateur || !navigateur.setAppBadge) return Promise.resolve();
  return self.registration
    .getNotifications()
    .then((affichees) =>
      affichees.length > 0 ? navigateur.setAppBadge(affichees.length) : navigateur.clearAppBadge(),
    )
    .catch(() => {});
}

self.addEventListener("push", (event) => {
  let charge = null;
  try {
    charge = event.data ? event.data.json() : null;
  } catch {
    // Un payload illisible ne vient pas de notre passerelle : rien à en tirer.
  }
  const roomId = charge && charge.room_id;

  if (!roomId) {
    /*
     * **Un réveil push doit toujours produire une notification.** C'est le contrat de
     * `userVisibleOnly`, et le navigateur le fait respecter : à défaut il affiche
     * lui-même « ce site a été mis à jour en arrière-plan », puis finit par retirer la
     * permission — une panne définitive, silencieuse, que l'utilisateur ne peut pas
     * diagnostiquer.
     *
     * Le cas ne devrait pas se produire : la passerelle n'émet **rien** sans `event_id`
     * ni `room_id`, badges de Synapse compris. S'il se produit quand même,
     * c'est un réveil dont on ne sait rien dire — et « Nouveau message » est alors plus
     * vrai que le silence.
     */
    event.waitUntil(
      self.registration
        .showNotification("Nouveau message", optionsNotification("tacita", undefined, null))
        .then(majBadge),
    );
    return;
  }

  event.waitUntil(
    demanderApercu(roomId, charge.event_id)
      .catch(() => null)
      .then((apercu) =>
        // clés absentes, événement pas encore synchronisé, aucune fenêtre
        // ouverte : notification **générique**, sans contenu et sans erreur bruyante.
        self.registration.showNotification(
          apercu ? apercu.expediteur : titreDeRepli(charge),
          optionsNotification(roomId, charge.event_id, apercu),
        ),
      )
      .then(majBadge),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(majBadge());
  const roomId = event.notification.data && event.notification.data.roomId;
  if (!roomId) return;

  // Même gabarit que `lib/routes.ts`, recopié parce qu'un service worker n'importe pas
  // le bundle de l'app. Le test de compare les deux : c'est lui qui tient la
  // paire, pas la vigilance.
  const cible = `/c?room=${encodeURIComponent(roomId)}`;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((fenetres) => {
        const fenetre = fenetres[0];
        if (!fenetre) return self.clients.openWindow(cible);
        // `navigate` n'existe pas partout, et **rejette** quand la fenêtre n'est pas
        // contrôlée par ce worker — le cas d'un onglet ouvert avant son installation.
        // Un tap qui n'ouvre rien est la pire réponse possible : on retombe alors sur
        // une fenêtre neuve, qui elle atterrit toujours au bon endroit.
        return fenetre
          .focus()
          .then((active) => (active.navigate ? active.navigate(cible) : null))
          .catch(() => self.clients.openWindow(cible));
      })
      .catch(() => null),
  );
});
