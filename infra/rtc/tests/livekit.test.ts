import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const livekit = parse(readFileSync(new URL("../livekit.yaml", import.meta.url), "utf-8"));
// `logLevel: silent` — le compose porte le tag `!override` (port 443
// du proxy), inconnu du parseur YAML générique.
const compose = parse(readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf-8"), {
  logLevel: "silent",
});

describe("le SFU ne crée jamais de salle de lui-même", () => {
  it("room.auto_create est false", () => {
    expect(livekit.room.auto_create).toBe(false);
  });
});

describe("découverte de l'IP publique par STUN", () => {
  it("rtc.use_external_ip est true", () => {
    expect(livekit.rtc.use_external_ip).toBe(true);
  });
});

describe("accès complet restreint au domaine du déploiement", () => {
  const homeservers =
    compose.services["lk-jwt-service"].environment.LIVEKIT_FULL_ACCESS_HOMESERVERS;

  it("LIVEKIT_FULL_ACCESS_HOMESERVERS vaut le domaine déployé", () => {
    expect(homeservers).toBe("${SERVER_NAME}");
  });

  it("n'est jamais le joker", () => {
    expect(homeservers).not.toContain("*");
  });
});

describe("TURN-TLS sur le port 5349, pas sur le 443", () => {
  it("le TURN est activé et écoute en TLS sur 5349", () => {
    expect(livekit.turn.enabled).toBe(true);
    expect(livekit.turn.tls_port).toBe(5349);
  });

  it("un certificat est fourni (TLS terminé par LiveKit, pas de load balancer)", () => {
    expect(livekit.turn.cert_file).toBeTruthy();
    expect(livekit.turn.key_file).toBeTruthy();
    expect(livekit.turn.external_tls).toBeUndefined();
  });

  it("s'annonce sous SERVER_NAME, sans sous-domaine à faire résoudre", () => {
    // Le certificat porte SERVER_NAME par construction : le TURN n'a donc besoin ni
    // d'un enregistrement DNS de plus, ni d'un SAN de plus. Un `TURN_DOMAIN` propre
    // était un troisième nom à créer, et un certificat à réémettre le jour de l'oubli.
    expect(compose.services["livekit-sfu"].environment.TURN_DOMAIN).toBe("${SERVER_NAME}");
    expect(livekit.turn.domain).toBe("__TURN_DOMAIN__");
  });
});

describe("une seule IPv4 suffit à l'hôte : le proxy garde le 443 pour lui seul", () => {
  // C'est la propriété qui rend les appels déployables en auto-hébergement. Tant que le
  // TURN-TLS prenait le 443, il fallait une seconde IP publique — que la plupart des
  // hôtes n'ont pas — et l'overlay refusait de démarrer sans elle.
  const turnPorts: string[] = compose.services["livekit-sfu"].ports;

  it("aucun port du SFU n'est épinglé sur une IP nommée", () => {
    for (const port of turnPorts) expect(port).not.toMatch(/\$\{/);
  });

  it("le SFU publie le TURN-TLS sur le port que déclare livekit.yaml", () => {
    const attendu = `${livekit.turn.tls_port}:${livekit.turn.tls_port}/tcp`;
    expect(turnPorts).toContain(attendu);
  });

  it("le SFU ne publie jamais le 443, et l'overlay ne redéfinit pas les ports du proxy", () => {
    expect(turnPorts.some((p) => p.startsWith("443:") || p.endsWith(":443/tcp"))).toBe(false);
    expect(compose.services.proxy.ports).toBeUndefined();
  });
});

describe("un jeton d'appel n'est délivré qu'à un membre du salon", () => {
  /*
   * Relevé en pentest, confirmé en ligne : n'importe quel compte obtenait un jeton
   * LiveKit pour n'importe quel salon dont il connaissait l'identifiant. lk-jwt-service
   * v0.9.0 vérifie `is_joined` (MSC4502) — mais **seulement** s'il tourne en application
   * service et que `LIVEKIT_FULL_ACCESS_HOMESERVERS` est exactement `LIVEKIT_HS_SERVER_NAME`
   * (`handler.rs`, `verifies_legacy_membership`). Chaque condition est une ligne qui, retirée,
   * éteint le contrôle sans rien casser.
   */
  const env = compose.services["lk-jwt-service"].environment;
  const enregistrement = parse(
    readFileSync(new URL("../lk-jwt-appservice.yaml.tmpl", import.meta.url), "utf-8"),
  );
  const homeserver = parse(
    readFileSync(new URL("../../synapse/homeserver.yaml.tmpl", import.meta.url), "utf-8"),
  );

  it("le service tourne en application service, sur notre seul serveur", () => {
    expect(env.LIVEKIT_HS_SERVER_NAME).toBe(env.LIVEKIT_FULL_ACCESS_HOMESERVERS);
    expect(env.LIVEKIT_AS_TOKEN).toBe("${LIVEKIT_AS_TOKEN}");
    expect(env.LIVEKIT_HS_TOKEN).toBe("${LIVEKIT_HS_TOKEN}");
  });

  it("Synapse charge l'enregistrement et sert `is_joined`", () => {
    const synapse = compose.services.synapse;
    expect(synapse.environment.SYNAPSE_APP_SERVICE_FILES).toBe(
      '["/data/appservice/lk-jwt-appservice.yaml"]',
    );
    expect(synapse.volumes).toContain(
      "./rtc/lk-jwt-appservice.yaml.tmpl:/conf/appservice/lk-jwt-appservice.yaml.tmpl:ro",
    );
    expect(homeserver.experimental_features.msc4502_enabled).toBe(true);
  });

  it("l'enregistrement ne donne que le scope, aucun espace de noms", () => {
    // L'exemple amont (`users: .*`) laisserait le jeton agir au nom de n'importe qui.
    expect(enregistrement.namespaces).toEqual({ users: [], aliases: [], rooms: [] });
    expect(enregistrement["io.element.msc4502.scopes"]).toEqual([
      "urn:matrix:client:io.element.msc4502:rooms:is_joined",
    ]);
    expect(enregistrement.url).toBeNull();
  });
});
