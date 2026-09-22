"use client";

import { useEffect } from "react";

import { brancherNotifications } from "../../lib/notifications";
import { activerPush, etatPush } from "../../lib/push";
import { useSession } from "../onboarding/SessionProvider";

/**
 * REQ-UI-18 — branche la réponse aux demandes du service worker, une fois pour l'onglet.
 *
 * Monté au-dessus des routes plutôt que dans un écran : un push peut réveiller le worker
 * pendant qu'on est n'importe où dans l'app, y compris sur les réglages.
 */
export function PontNotifications() {
  const { etat } = useSession();
  const session = etat.phase === "prete" ? etat.session : null;

  useEffect(() => (session ? brancherNotifications(session) : undefined), [session]);

  // Le pusher vit côté serveur : ceux enregistrés avant E-12 sont encore en
  // `event_id_only`, et n'enverraient jamais l'expéditeur. On le réécrit à l'ouverture
  // quand le push est déjà actif — la permission est acquise, rien n'est redemandé à
  // l'utilisateur. Un échec laisse l'ancien pusher en place : dégradé, pas cassé.
  useEffect(() => {
    if (!session) return;
    void etatPush()
      .then((etat) => (etat === "actif" ? activerPush(session) : undefined))
      .catch(() => {});
  }, [session]);

  return null;
}
