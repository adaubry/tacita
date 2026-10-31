/**
 * Les vérifications de configuration : ce que `doctor` lit dans les fichiers.
 *
 * Une `Verification` par sujet — fichier `.env` présent, nom de serveur posé, secrets
 * remplis, clés VAPID de la bonne longueur, certificat en place. Chacune rend un
 * constat **et son remède** : un diagnostic qui ne dit pas quoi faire ne sert à rien.
 *
 * Ces tests attestent le contenu des fichiers. Ils ne disent pas que le produit
 * marche — c'est l'autre porte.
 */
import { X509Certificate } from "node:crypto";

import {
  attente,
  attention,
  casse,
  ok,
  type Constat,
  type Contexte,
  type Verification,
} from "./contrat.ts";

/** Parse un fichier d'environnement. Pas de dépendance : `KEY=valeur`, `#` en commentaire. */
export function lireEnv(contenu: string): Map<string, string> {
  const valeurs = new Map<string, string>();
  for (const ligne of contenu.split("\n")) {
    const nette = ligne.trim();
    if (nette === "" || nette.startsWith("#")) continue;
    const coupure = nette.indexOf("=");
    if (coupure <= 0) continue;
    valeurs.set(nette.slice(0, coupure).trim(), nette.slice(coupure + 1).trim());
  }
  return valeurs;
}

export const FICHIER_ENV = "infra/.env";
export const FICHIER_ENV_EXEMPLE = "infra/.env.example";
export const CHEMIN_CERT = "infra/proxy/certs/fullchain.pem";

/**
 * Une vérification qui n'a de sens qu'avec le fichier d'environnement. Sans ce garde,
 * l'absence d'`infra/.env` produisait huit rouges pour une seule cause.
 */
const dependDeEnv =
  (nom: string, verifier: (env: ReadonlyMap<string, string>, ctx: Contexte) => Constat) =>
  (ctx: Contexte): Constat =>
    ctx.env === undefined ? attente(nom, "en attente d'infra/.env") : verifier(ctx.env, ctx);

/**
 * Les variables sans lesquelles la pile ne peut pas fonctionner. `.env.example` les livre
 * toutes sur `change-me` : laissées telles quelles, chacune casse quelque chose, et la
 * plupart le font en silence.
 */
export const SECRETS_REQUIS = [
  "POSTGRES_PASSWORD",
  "SYNAPSE_REGISTRATION_SHARED_SECRET",
  "SYNAPSE_MACAROON_SECRET_KEY",
  "SYNAPSE_FORM_SECRET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "GARAGE_RPC_SECRET",
  // Les appels font partie de la pile : le SFU ne fait confiance
  // qu'aux jetons que `lk-jwt-service` signe avec cette paire. Laissée sur `change-me`,
  // les deux la partagent quand même et rien n'échoue au démarrage — le premier appel
  // seul découvre que n'importe qui pouvait forger un jeton.
  "LIVEKIT_KEY",
  "LIVEKIT_SECRET",
  // Sans eux, lk-jwt-service ne démarre pas en application service et délivre des
  // jetons d'appel sans vérifier l'appartenance au salon.
  "LIVEKIT_AS_TOKEN",
  "LIVEKIT_HS_TOKEN",
];

export const fichierEnv: Verification = {
  nom: "infra/.env",
  phase: "Configuration",
  verifier: ({ env }) =>
    env === undefined
      ? casse(
          "infra/.env",
          "le fichier n'existe pas — rien ne peut démarrer sans lui",
          "pnpm admin init --domaine=chat.ton-domaine.fr --email=toi@ton-domaine.fr",
        )
      : ok("infra/.env", `présent, ${env.size} variables lues`),
};

/**
 * Ce nom entre dans chaque identifiant Matrix, chaque clé de salon et chaque signature
 * d'appareil. Le changer ne renomme rien : il crée un autre homeserver et abandonne
 * l'ancien. Le laisser sur l'exemple produit un déploiement qu'on ne peut pas rattraper.
 */
export const nomDuServeur: Verification = {
  nom: "SERVER_NAME",
  phase: "Configuration",
  verifier: dependDeEnv("SERVER_NAME", (env, { dev }) => {
    const nom = env.get("SERVER_NAME") ?? "";
    if (nom === "")
      return casse("SERVER_NAME", "absent", "SERVER_NAME=chat.ton-domaine.fr dans infra/.env");
    if (nom.endsWith("example.org") || nom.endsWith("example.com"))
      return dev
        ? ok("SERVER_NAME", `${nom} — nom d'exemple, attendu en développement`)
        : casse(
            "SERVER_NAME",
            `« ${nom} » est le nom d'exemple — il est définitif une fois la pile démarrée`,
            "le remplacer par ton vrai domaine AVANT le premier docker compose up",
          );
    return ok("SERVER_NAME", nom);
  }),
};

export const secretsRemplis: Verification = {
  nom: "secrets",
  phase: "Configuration",
  verifier: dependDeEnv("secrets", (env) => {
    const restants = SECRETS_REQUIS.filter((cle) => (env.get(cle) ?? "change-me") === "change-me");
    return restants.length === 0
      ? ok("secrets", `${SECRETS_REQUIS.length} secrets renseignés`)
      : casse(
          "secrets",
          `encore sur « change-me » : ${restants.join(", ")}`,
          "pnpm admin init les génère, sans écraser ceux qui sont déjà posés",
        );
  }),
};

/**
 * Le tueur silencieux n°1. La passerelle refuse une clé VAPID invalide et sort ; le
 * conteneur repart en boucle, `docker compose ps` affiche la pile debout, `/push/config`
 * répond 502, et aucune notification ne part jamais — pour personne. Les longueurs sont
 * celles d'une paire P-256 en base64url : 87 et 43 caractères, exactement.
 */
export const clesVapid: Verification = {
  nom: "clés VAPID",
  phase: "Configuration",
  verifier: dependDeEnv("clés VAPID", (env) => {
    const attendues = [
      ["VAPID_PUBLIC_KEY", 87],
      ["VAPID_PRIVATE_KEY", 43],
    ] as const;
    const fautives = attendues
      .filter(([cle, longueur]) => (env.get(cle) ?? "").length !== longueur)
      .map(
        ([cle, longueur]) =>
          `${cle} fait ${(env.get(cle) ?? "").length} caractères, il en faut ${longueur}`,
      );
    return fautives.length === 0
      ? ok("clés VAPID", "paire présente et de la bonne longueur")
      : casse(
          "clés VAPID",
          `${fautives.join(" ; ")} — la passerelle push redémarrera en boucle sans le dire`,
          "pnpm admin init génère la paire, sans conteneur jetable ni copier-coller",
        );
  }),
};

/** Apple refuse le push sans émetteur identifiable ; le service push rend alors un 400. */
export const sujetVapid: Verification = {
  nom: "VAPID_SUBJECT",
  phase: "Configuration",
  verifier: dependDeEnv("VAPID_SUBJECT", (env) => {
    const sujet = env.get("VAPID_SUBJECT") ?? "";
    return /^(mailto:\S+@\S+|https:\/\/\S+)$/.test(sujet)
      ? ok("VAPID_SUBJECT", sujet)
      : casse(
          "VAPID_SUBJECT",
          `« ${sujet} » n'est ni un mailto: ni un https: — Apple refusera le push`,
          "VAPID_SUBJECT=mailto:admin@ton-domaine.fr dans infra/.env",
        );
  }),
};

/**
 * Le tueur silencieux n°2, et de la même famille que le premier : c'est Synapse qui
 * appelle la passerelle, à une adresse du réseau Docker, donc privée. Son client sortant
 * applique `ip_range_blacklist`, qui contient `172.16.0.0/12` par défaut. Liste vide, le
 * pusher s'enregistre, l'interface annonce des notifications actives, et Synapse n'appelle
 * jamais. Rien, nulle part, ne le dit.
 */
export const plagesAutorisees: Verification = {
  nom: "SYNAPSE_IP_RANGE_WHITELIST",
  phase: "Configuration",
  verifier: dependDeEnv("SYNAPSE_IP_RANGE_WHITELIST", (env) => {
    const brut = env.get("SYNAPSE_IP_RANGE_WHITELIST") ?? "";
    return brut === "" || brut === "[]"
      ? casse(
          "SYNAPSE_IP_RANGE_WHITELIST",
          "vide — Synapse n'appellera jamais la passerelle push, et rien ne le signalera",
          'SYNAPSE_IP_RANGE_WHITELIST=["172.16.0.0/12"] dans infra/.env (la plage du réseau Docker)',
        )
      : ok("SYNAPSE_IP_RANGE_WHITELIST", brut);
  }),
};

/**
 * Les trois formats que Garage refuse au démarrage, relevés sur v2.5.0 : `rpc_secret`
 * doit faire 32 octets en hexadécimal, l'identifiant de clé S3 au moins 8 caractères, son
 * secret au moins 16. Chacun fait sortir le processus en nommant la cause — mais le
 * conteneur repart en boucle, Synapse qui l'attend en `service_healthy` ne démarre jamais,
 * et `docker compose ps` montre une pile qui semble se lancer.
 */
export const clesGarage: Verification = {
  nom: "clés Garage",
  phase: "Configuration",
  verifier: dependDeEnv("clés Garage", (env) => {
    const fautes = [
      !/^[0-9a-f]{64}$/i.test(env.get("GARAGE_RPC_SECRET") ?? "") &&
        "GARAGE_RPC_SECRET : attendu 32 octets en hexadécimal",
      (env.get("S3_ACCESS_KEY_ID") ?? "").length < 8 && "S3_ACCESS_KEY_ID : au moins 8 caractères",
      (env.get("S3_SECRET_ACCESS_KEY") ?? "").length < 16 &&
        "S3_SECRET_ACCESS_KEY : au moins 16 caractères",
    ].filter((faute): faute is string => typeof faute === "string");
    return fautes.length === 0
      ? ok("clés Garage", "formats conformes")
      : casse(
          "clés Garage",
          `${fautes.join(" ; ")} — Garage refusera de démarrer`,
          "pnpm admin init les génère sur un .env neuf ; sur un .env déjà posé, ajouter GARAGE_RPC_SECRET=$(openssl rand -hex 32) à la main, et raccourci, S3_ACCESS_KEY_ID se change de même",
        );
  }),
};

/**
 * Quatre choses peuvent clocher, et une seule était visible avant qu'on la cherche :
 * l'absence de `subjectAltName`. `service_identity` — donc Twisted, donc Synapse — refuse
 * un certificat sans SAN, et tout navigateur depuis 2017 aussi. Un certificat au seul
 * `/CN=` paraît bon partout sauf là où il sert.
 */
export const certificat: Verification = {
  nom: "certificat TLS",
  phase: "Certificat",
  verifier: ({ env, lire, maintenant, dev }) => {
    const serveur = env?.get("SERVER_NAME") ?? "";
    const pem = lire(CHEMIN_CERT);
    if (pem === undefined)
      return casse(
        "certificat TLS",
        `${CHEMIN_CERT} absent — le proxy ne démarrera pas`,
        dev
          ? "cd infra && ./proxy/generate-dev-certs.sh"
          : serveur === ""
            ? "sudo certbot certonly --standalone -d <ton domaine> -d call.<ton domaine>"
            : `sudo certbot certonly --standalone -d ${serveur} -d call.${serveur}`,
      );

    let x509: X509Certificate;
    try {
      x509 = new X509Certificate(pem);
    } catch {
      return casse("certificat TLS", `${CHEMIN_CERT} n'est pas un certificat lisible`, "le réémettre");
    }

    const noms = (x509.subjectAltName ?? "")
      .split(",")
      .map((entree) => entree.trim().replace(/^DNS:/, ""))
      .filter((entree) => entree !== "");
    if (noms.length === 0)
      return casse(
        "certificat TLS",
        "aucun subjectAltName — Synapse et les navigateurs le refuseront tous les deux",
        "le réémettre avec -addext subjectAltName=DNS:... (./proxy/generate-dev-certs.sh le fait)",
      );

    const absents = (serveur === "" ? [] : [serveur, `call.${serveur}`]).filter(
      (nom) => !noms.includes(nom),
    );
    if (absents.length > 0)
      return casse(
        "certificat TLS",
        `ne couvre pas ${absents.join(" ni ")} — il porte ${noms.join(", ")}`,
        `réémettre en incluant ${absents.join(" et ")} : le certificat doit les porter dès l'émission`,
      );

    const joursRestants = Math.floor(
      (new Date(x509.validTo).getTime() - maintenant.getTime()) / 86_400_000,
    );
    if (joursRestants < 0)
      return casse(
        "certificat TLS",
        `expiré depuis ${-joursRestants} jours`,
        "sudo certbot renew --force-renewal",
      );
    if (joursRestants < 15)
      return attention(
        "certificat TLS",
        `expire dans ${joursRestants} jours`,
        "vérifier que le hook de renouvellement est bien posé (infra/staging/README.md)",
      );
    return ok("certificat TLS", `couvre ${noms.join(", ")}, expire dans ${joursRestants} jours`);
  },
};

/** L'ordre est celui du déroulé : ce qui bloque le plus tôt se lit en premier. */
export const VERIFICATIONS_CONFIG: readonly Verification[] = [
  fichierEnv,
  nomDuServeur,
  secretsRemplis,
  clesVapid,
  sujetVapid,
  plagesAutorisees,
  clesGarage,
  certificat,
];
