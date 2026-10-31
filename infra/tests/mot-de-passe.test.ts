import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * **le garde du changement de mot de passe tient sur trois fichiers qui ne se
 * lisent jamais ensemble**, et retirer n'importe lequel des trois le désarme en silence.
 *
 * 1. `proxy/nginx.conf` ferme `POST /_matrix/client/v3/account/password`. Sans ce bloc,
 *    l'UIA `m.login.password` de l'endpoint standard suffit à changer le mot de passe :
 *    le garde devient décoratif, et **rien ne casse** — c'est le pire des symptômes.
 * 2. `synapse/homeserver.yaml.tmpl` charge le module, seul chemin restant.
 * 3. `synapse/Dockerfile` met son répertoire dans le `PYTHONPATH` : sans lui, `modules:`
 *    lève au démarrage et le homeserver ne boote pas du tout (règle 4).
 *
 * Ce que ce fichier ne prouve pas : que le module accepte une vraie clé. Ça se joue contre
 * un serveur qui tourne, et l'accord des deux implémentations de la vérification est tenu
 * par `packages/client-core/tests/key-check-python.test.ts`.
 */
const ici = (c: string) => new URL(c, import.meta.url);
const lire = (c: string) => readFileSync(ici(c), "utf-8");

const nginx = lire("../proxy/nginx.conf");
const homeserver = parse(lire("../synapse/homeserver.yaml.tmpl"));
const dockerfile = lire("../synapse/Dockerfile");
const compose = parse(lire("../docker-compose.yml"));
const module = lire("../synapse/modules/tacita_password.py");
const clientCore = readFileSync(ici("../../packages/client-core/src/session.ts"), "utf-8");

const CHEMIN = "/_synapse/client/tacita/password";
const CHEMIN_SECOURS = "/_synapse/client/tacita/login_recovery";

/** Le corps de la ressource de secours, et rien d'autre du fichier. */
const ressourceSecours = module.slice(
  module.indexOf("class _RessourceConnexion"),
  module.indexOf("class _RessourceRemplacement"),
);

describe("D-12 — l'endpoint standard de changement de mot de passe est fermé", () => {
  it("nginx renvoie 403 sur les deux versions du chemin", () => {
    /*
     * `r0` comme `v3` : Synapse sert encore l'ancien préfixe, et n'en fermer qu'un
     * laisserait un contournement d'une ligne à quiconque connaît l'API.
     */
    for (const version of ["v3", "r0"]) {
      const debut = nginx.indexOf(`location ^~ /_matrix/client/${version}/account/password`);
      expect(debut, `bloc ${version} absent`).toBeGreaterThan(-1);
      // Le corps du bloc, et rien d'autre : un `return 403;` trouvé ailleurs dans le
      // fichier ne dirait rien de celui-ci.
      const corps = nginx.slice(debut, nginx.indexOf("}", debut));
      expect(corps).toContain("return 403;");
    }
  });

  it("le blocage est en `^~`, sinon la route générique reste candidate", () => {
    // Sans `^~`, nginx compare deux préfixes et l'ordre du fichier ne tranche rien : la
    // requête pourrait repartir vers Synapse par `location /_matrix`.
    expect(nginx).toContain("location ^~ /_matrix/client/v3/account/password");
  });
});

describe("D-12 — le chemin de remplacement existe, des deux côtés", () => {
  it("le module est chargé par le homeserver", () => {
    const modules = homeserver.modules as { module: string }[];
    expect(modules.map((m) => m.module)).toContain("tacita_password.TacitaPassword");
  });

  it("son répertoire est monté et dans le PYTHONPATH", () => {
    /*
     * Les deux ensemble, et pas l'un sans l'autre : monté sans PYTHONPATH, le module est
     * là et introuvable ; dans le PYTHONPATH sans montage, le répertoire est vide. Les
     * deux cas donnent le même symptôme — Synapse refuse de démarrer.
     */
    expect(compose.services.synapse.volumes).toContain("./synapse/modules:/conf/modules:ro");
    expect(dockerfile).toMatch(/^ENV PYTHONPATH=\/conf\/modules$/m);
  });

  it("le module sert le chemin que le client appelle", () => {
    // La jonction la plus bête et la plus facile à casser : deux chaînes, deux langages,
    // rien qui les relie. Un renommage d'un côté donne un 404 que personne n'attribue.
    expect(module).toContain(`register_web_resource("${CHEMIN}"`);
    expect(clientCore).toContain(`"${CHEMIN}"`);
  });
});

describe("D-12 — la clé est vérifiée par le serveur, pas seulement par l'écran", () => {
  it("le module refuse sans descripteur de clé, plutôt que de laisser passer", () => {
    // Un compte sans clé de récupération n'a rien à opposer : laisser passer ferait du
    // garde une option, et l'interdit n°13 en ferait une promesse non tenue.
    expect(module).toMatch(/descripteur is None/);
    expect(module).toMatch(/"errcode": "M_FORBIDDEN"/);
  });

  it("la comparaison du MAC est à temps constant", () => {
    // Une comparaison de chaînes fuirait par le temps ce que le MAC existe pour protéger.
    expect(module).toContain("hmac.compare_digest");
  });

  it("la clé n'est jamais journalisée", () => {
    /*
     * D-12 dit « non stocké n'est pas non vu » ; le minimum que ce module doive tenir est
     * de ne pas l'écrire lui-même. Aucun logger n'est importé — la vérification porte sur
     * l'absence, parce qu'un `logger.info` ajouté un jour de débogage est exactement la
     * façon dont ce genre de secret finit sur disque.
     */
    expect(module).not.toMatch(/logger|logging|print\(/);
  });
});

describe("D-14 — la clé de récupération ouvre une session quand le mot de passe est perdu", () => {
  it("le module sert le chemin que le client appelle", () => {
    // Même jonction que celle de D-12, et aussi bête : deux chaînes, deux langages, rien
    // qui les relie. Un renommage d'un côté donne un 404 que personne n'attribue.
    expect(module).toContain(`register_web_resource(\n        "${CHEMIN_SECOURS}"`);
    expect(clientCore).toContain(`"${CHEMIN_SECOURS}"`);
  });

  it("la porte est ouverte, donc elle est limitée en débit", () => {
    /*
     * Cet endpoint est le seul du déploiement qui authentifie **sans** jeton. Une clé de
     * 256 bits ne s'énumère pas de front, mais un endpoint d'authentification qui ne
     * compte pas ses échecs n'a aucun moyen de voir qu'on l'essaie. Le
     * limiteur est celui du serveur, par IP, dimensionné par pas un compteur
     * maison qui aurait sa propre idée du débit.
     */
    expect(ressourceSecours).toContain("Ratelimiter(");
    expect(ressourceSecours).toContain("rc_login_address");
    expect(ressourceSecours).toMatch(/await self\._limiteur\.ratelimit\(/);
  });

  it("un compte désactivé ne se rouvre pas avec sa clé", () => {
    /*
     * D-13 fait de la désactivation la réponse à un compte indésirable. Sans cette
     * vérification, cette réponse-là se contournerait avec un secret que le compte détient
     * déjà — et le symptôme serait un compte fermé qui se rouvre tout seul.
     */
    expect(ressourceSecours).toContain("is_deactivated");
  });

  it("un seul message pour toutes les causes de refus", () => {
    /*
     * Compte inconnu, désactivé, sans clé, clé fausse : la même réponse. Les distinguer
     * donnerait un oracle de comptes à qui interroge cette porte ouverte — même
     * jurisprudence que, et l'écran ne peut donc rien dire de plus précis.
     */
    expect(ressourceSecours.match(/respond_with_json\(\s*request,\s*403/g)).toHaveLength(1);
  });

  it("le serveur rend un jeton de connexion, jamais un jeton d'accès", () => {
    /*
     * `create_login_token` puis `/login` natif : Synapse crée l'appareil, applique ses
     * limites et journalise la connexion. Un module qui fabriquerait le jeton d'accès
     * lui-même se mettrait hors de tout ça, sans que rien ne le dise.
     */
    expect(ressourceSecours).toContain("create_login_token");
    expect(ressourceSecours).not.toContain("register_device");
    expect(clientCore).toContain('type: "m.login.token"');
  });
});

describe("le plancher de mot de passe est dit au même nombre partout", () => {
  /*
   * **Mesuré : un compte s'est créé avec le mot de passe « a ».** Le
   * plancher existait à deux endroits — le module et l'écran de changement — et à aucun
   * des deux qui compte : rien ne gardait la création. Depuis, ce mot de passe est
   * la clé qui déchiffre l'historique.
   *
   * Trois fichiers portent le nombre, dans trois langages, et rien ne les compile
   * ensemble. C'est la règle 7 : ce test est le seul endroit où ils se rencontrent. Deux
   * nombres différents ne casseraient rien — l'écran refuserait ce que le serveur accepte,
   * ou pire, promettrait ce qu'il refuse.
   */
  const PLANCHER = 12;

  it("Synapse l'impose, et c'est le seul garde opposable", () => {
    // Sans `policy.enabled`, la politique de Synapse est éteinte et `minimum_length` ne
    // vaut rien : les deux lignes ne se séparent pas.
    expect(homeserver.password_config.policy.enabled).toBe(true);
    expect(homeserver.password_config.policy.minimum_length).toBe(PLANCHER);
  });

  it("le module de changement dit le même nombre", () => {
    expect(module).toMatch(new RegExp(`LONGUEUR_MINIMALE = ${PLANCHER}\\b`));
  });

  it("le shard aussi, et il ne le recopie pas — il le lit du paquet", () => {
    /*
     * Le nombre du shard vient de `client-core`, pas d'une constante d'écran : deux écrans
     * en parlent (création et changement) et une troisième copie était l'occasion de la
     * divergence suivante.
     */
    expect(clientCore).toMatch(
      new RegExp(`LONGUEUR_MINIMALE_MOT_DE_PASSE = ${PLANCHER}\\b`),
    );
  });
});

describe("la clé est vérifiée contre l'épingle du serveur, jamais contre l'account data", () => {
  /*
   * Relevé en pentest, confirmé en ligne : l'account data est écrite par n'importe quelle
   * session. Vérifier la clé contre elle laissait un jeton volé y poser le descripteur
   * d'une clé connue de lui, puis changer le mot de passe et s'ouvrir `login_recovery`.
   * Scénario rejoué de bout en bout contre un Synapse 1.155 (reprise, refus, ré-épinglage).
   */
  const corps = (debut: string, fin: string) => module.slice(module.indexOf(debut), module.indexOf(fin));

  it("les deux portes lisent l'épingle", () => {
    expect(corps("class _Ressource(", "async def _descripteur")).toContain("await _epingle(");
    expect(ressourceSecours).toContain("await _epingle(");
    expect(corps("class _Ressource(", "async def _descripteur")).not.toContain("await _descripteur(");
    expect(ressourceSecours).not.toContain("await _descripteur(");
  });

  it("une écriture d'account data n'épingle que la première clé", () => {
    expect(module).toContain("register_account_data_callbacks(on_account_data_updated=");
    expect(corps("async def ecriture", "api.register_account_data_callbacks")).toContain(
      "remplacer=False",
    );
  });

  it("remplacer l'épingle exige le mot de passe, et l'app l'appelle après une réinitialisation", () => {
    const remplacement = corps("class _RessourceRemplacement", "def create_module");
    expect(remplacement).toContain("_check_local_password(");
    expect(remplacement).toContain("remplacer=True");
    expect(module).toContain('"/_synapse/client/tacita/recovery_key"');
    expect(clientCore).toContain('"/_synapse/client/tacita/recovery_key"');
  });
});
