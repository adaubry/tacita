"""D-12 / D-14 — la clé de récupération, opposée par le serveur.

Deux chemins vivent ici, et le second n'existe que parce que le premier a fermé une porte :

- ``POST /_synapse/client/tacita/password`` (D-12) — changer son mot de passe, la clé à
  l'appui, depuis une session ouverte ;
- ``POST /_synapse/client/tacita/login_recovery`` (D-14) — **ouvrir une session avec la
  clé seule**, quand le mot de passe est perdu. Sans lui, un mot de passe oublié est un
  compte mort : ce déploiement n'a ni e-mail ni SSO, et l'endpoint standard de changement
  de mot de passe est fermé au proxy — il n'existait aucune porte de secours.

Ils partagent la vérification de clé, et ce n'est pas une économie de lignes : deux
implémentations du même contrôle dériveraient, et celle qui dérive est celle qui laisse
passer.

**Pourquoi ce module existe, et pourquoi ce n'est pas un stage UIA.** Vérifié dans l'image
déployée (Synapse v1.155.0, ``synapse/config/auth.py``) :

    password_enabled_for_login  = passwords_enabled and not passwords_for_reauth_only
    password_enabled_for_reauth = passwords_for_reauth_only or passwords_enabled

Les deux dérivent du même ``password_config.enabled``. Il n'existe donc **aucune**
configuration « connexion oui, ré-authentification non ». Or les types UIA sont des
alternatives : un stage maison serait offert *à côté* de ``m.login.password``, qui resterait
acceptable, et le garde serait décoratif. Un module ne contourne rien —
``AuthHandler.get_supported_login_types`` filtre ``m.login.password`` par le même drapeau.

D'où cette forme : ``POST /_matrix/client/v3/account/password`` est **bloqué au proxy**
(``infra/proxy/nginx.conf``), et ce module est le seul chemin restant. Les deux vont
ensemble — retirer la règle nginx rouvre le contournement sans que rien ne le dise. C'est
une jonction au sens de la règle 7, et ``infra/tests/mot-de-passe.test.ts`` la relit.

**Ce que ça coûte, et qui est écrit dans D-12** : la clé de récupération transite en clair
jusqu'ici. Elle n'ouvre pas un message, elle ouvre le magasin — un serveur qui la capte
déchiffre tout l'historique du compte. Non stocké n'est pas non vu. Ce module ne la
journalise nulle part et ne la garde pas au-delà de la requête ; c'est tout ce qu'il peut
faire, et ce n'est pas une protection contre l'opérateur.
"""

from __future__ import annotations

import hmac
import json
from base64 import b64decode, b64encode
from hashlib import sha256
from collections.abc import Mapping
from typing import Any

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from synapse.api.ratelimiting import Ratelimiter
from synapse.http.server import DirectServeJsonResource, respond_with_json
from synapse.http.servlet import parse_json_object_from_request
from synapse.http.site import SynapseRequest
from synapse.module_api import ModuleApi


# Le type d'account data qui décrit la clé de secret storage par défaut, et celui qui dit
# laquelle est la clé par défaut. Tous deux dans la spec Matrix (« Secret storage »).
DEFAUT = "m.secret_storage.default_key"
DESCRIPTION = "m.secret_storage.key."

# `m.secret_storage.v1.aes-hmac-sha2`, seul algorithme que la spec définisse — et celui que
# `createRecoveryKeyFromPassphrase` produit. Un autre serait un compte qu'on ne sait pas
# vérifier : on refuse plutôt que de laisser passer.
ALGORITHME = "m.secret_storage.v1.aes-hmac-sha2"

# Le plancher de longueur, **le même que `password_config.policy` du homeserver** et que
# celui du shard. Porté à 12 le 25/08/2026 : depuis D-15 ce mot de passe est la clé qui
# déchiffre l'historique, et il n'avait aucun plancher du tout à la création de compte.
# Il est ici et pas seulement dans l'UI — un garde côté écran n'en est pas un — et un test
# d'infra relie les trois endroits qui le disent.
LONGUEUR_MINIMALE = 12


def _verifier_cle(cle: bytes, iv_b64: str, mac_b64: str) -> bool:
    """La vérification de clé de la spec Matrix, § « Secret storage », key check.

    HKDF-SHA256 sur la clé, sel de 32 zéros, ``info`` vide — puis AES-CTR sur 32 octets nuls
    avec l'``iv`` du descripteur, et HMAC-SHA256 du chiffré. Le résultat doit être le ``mac``
    que porte l'account data.

    C'est exactement ce que ``secretStorage.checkKey`` fait côté client (le shard le fait
    aussi, pour rendre la faute de frappe immédiate) — mais c'est **ici** que ça compte :
    un contrôle client se contourne en n'utilisant pas notre client.
    """
    derive = HKDF(algorithm=SHA256(), length=64, salt=bytes(32), info=b"").derive(cle)
    aes_key, hmac_key = derive[:32], derive[32:]

    iv = b64decode(iv_b64)
    if len(iv) != 16:
        return False

    chiffre = Cipher(algorithms.AES(aes_key), modes.CTR(iv)).encryptor()
    sortie = chiffre.update(bytes(32)) + chiffre.finalize()
    attendu = hmac.new(hmac_key, sortie, sha256).digest()

    # Comparaison à temps constant, et sur les octets décodés : deux base64 différents
    # peuvent coder les mêmes octets (padding), et une comparaison de chaînes fuirait par
    # le temps ce que le MAC existe pour protéger.
    try:
        return hmac.compare_digest(attendu, b64decode(mac_b64))
    except Exception:
        return False


class _Ressource(DirectServeJsonResource):
    def __init__(self, api: ModuleApi) -> None:
        super().__init__()
        self._api = api

    async def _async_render_POST(self, request: SynapseRequest) -> None:
        # L'appelant est identifié par son jeton d'accès, comme tout endpoint client. Ça ne
        # suffit pas à autoriser le changement — c'est précisément le point de D-12 : une
        # session volée ne doit pas pouvoir changer le mot de passe.
        requester = await self._api.get_user_by_req(request)
        user_id = requester.user.to_string()

        corps = parse_json_object_from_request(request)
        cle_b64 = corps.get("recovery_key")
        nouveau = corps.get("new_password")

        if not isinstance(cle_b64, str) or not isinstance(nouveau, str):
            respond_with_json(request, 400, {"errcode": "M_MISSING_PARAM"}, send_cors=True)
            return

        if len(nouveau) < LONGUEUR_MINIMALE:
            respond_with_json(
                request,
                400,
                {"errcode": "M_WEAK_PASSWORD", "error": "mot de passe trop court"},
                send_cors=True,
            )
            return

        descripteur = await _epingle(self._api, user_id)
        if descripteur is None:
            # Aucune clé de récupération sur ce compte : il n'y a rien à opposer, et
            # laisser passer ferait du garde une option. On refuse, et le message dit quoi
            # faire — c'est la règle 2, classer par résolubilité.
            respond_with_json(
                request,
                403,
                {
                    "errcode": "M_FORBIDDEN",
                    "error": "ce compte n'a pas de clé de récupération",
                },
                send_cors=True,
            )
            return

        if not _cle_valide(cle_b64, descripteur):
            respond_with_json(
                request,
                403,
                {"errcode": "M_FORBIDDEN", "error": "clé de récupération incorrecte"},
                send_cors=True,
            )
            return

        auth_handler = self._api._auth_handler
        empreinte = await auth_handler.hash(nouveau)
        # `logout_devices=False` : le changement de mot de passe n'est pas une réponse à une
        # compromission ici — il est gardé par la clé, que seul le titulaire a. Déconnecter
        # tous les appareils ferait perdre l'historique déchiffré de chacun,
        # pour un gain nul. La déconnexion reste un geste explicite.
        await self._api._hs.get_set_password_handler().set_password(
            user_id, empreinte, False, requester
        )
        respond_with_json(request, 200, {}, send_cors=True)


async def _descripteur(api: ModuleApi, user_id: str) -> dict[str, Any] | None:
    """Le descripteur de la clé de secret storage par défaut du compte, ou ``None``."""
    manager = api.account_data_manager
    defaut = await manager.get_global(user_id, DEFAUT)
    if not defaut or not isinstance(defaut.get("key"), str):
        return None

    # Un descripteur sans `iv`/`mac` existe : c'est le cas d'une clé dérivée d'une
    # passphrase et jamais vérifiée. Rien à opposer, donc `_valide` refuse.
    return _valide(await manager.get_global(user_id, DESCRIPTION + defaut["key"]))


# **L'épingle : le descripteur auquel le serveur se fie, et que le client ne peut pas
# réécrire.**
#
# L'account data est écrite par n'importe quelle session du compte. Vérifier la clé contre
# elle, c'était laisser une session volée — sans mot de passe ni clé — y poser le
# descripteur d'une clé qu'elle connaît, puis changer le mot de passe et s'ouvrir
# `login_recovery` à volonté (relevé en pentest, confirmé en ligne). Le module garde donc
# sa propre copie :
#
# - posée au **premier** descripteur valide que le compte écrit (l'inscription), ou à la
#   reprise des comptes existants au démarrage ;
# - jamais remplacée par une écriture d'account data — seulement par
#   `/_synapse/client/tacita/recovery_key`, **mot de passe à l'appui**. C'est le geste
#   « j'ai perdu ma clé », qui demande déjà le mot de passe (UIA du cross-signing), et
#   depuis D-15 la clé dérive de ce mot de passe : il n'ouvre rien de plus qu'avant.
#
# Limite assumée : un compte qui n'a jamais posé de clé est épinglé par la première
# session qui en écrit une. C'est le compte d'une inscription interrompue, sans
# historique à protéger.
TABLE = "tacita_cle_epinglee"


def _creer_table(txn: Any) -> None:
    txn.execute(
        f"CREATE TABLE IF NOT EXISTS {TABLE} (user_id TEXT PRIMARY KEY, descripteur TEXT NOT NULL)"
    )


def _lire_epingle(txn: Any, user_id: str) -> dict[str, Any] | None:
    txn.execute(f"SELECT descripteur FROM {TABLE} WHERE user_id = ?", (user_id,))
    ligne = txn.fetchone()
    return json.loads(ligne[0]) if ligne else None


def _ecrire_epingle(txn: Any, user_id: str, descripteur: dict[str, Any], remplacer: bool) -> None:
    conflit = "DO UPDATE SET descripteur = excluded.descripteur" if remplacer else "DO NOTHING"
    txn.execute(
        f"INSERT INTO {TABLE} (user_id, descripteur) VALUES (?, ?) ON CONFLICT (user_id) {conflit}",
        (user_id, json.dumps(descripteur)),
    )


def _reprendre_existants(txn: Any) -> None:
    """Épingle, une fois, le descripteur courant de chaque compte qui n'en a pas encore."""
    _creer_table(txn)
    txn.execute(
        "SELECT user_id, content FROM account_data WHERE account_data_type = ?"
        f" AND user_id NOT IN (SELECT user_id FROM {TABLE})",
        (DEFAUT,),
    )
    for user_id, contenu in txn.fetchall():
        cle = json.loads(contenu).get("key")
        if not isinstance(cle, str):
            continue
        txn.execute(
            "SELECT content FROM account_data WHERE user_id = ? AND account_data_type = ?",
            (user_id, DESCRIPTION + cle),
        )
        ligne = txn.fetchone()
        descripteur = _valide(json.loads(ligne[0])) if ligne else None
        if descripteur is not None:
            _ecrire_epingle(txn, user_id, descripteur, remplacer=False)


def _valide(description: Any) -> dict[str, Any] | None:
    """Le descripteur s'il est vérifiable (algorithme connu, `iv` et `mac`), sinon ``None``."""
    # `Mapping` et pas `dict` : l'account data sort de Synapse en dictionnaire immuable.
    if not isinstance(description, Mapping) or description.get("algorithm") != ALGORITHME:
        return None
    if not isinstance(description.get("iv"), str) or not isinstance(description.get("mac"), str):
        return None
    return dict(description)


async def _epingle(api: ModuleApi, user_id: str) -> dict[str, Any] | None:
    """Le descripteur épinglé du compte — **le seul** contre lequel une clé est vérifiée."""
    return await api.run_db_interaction("tacita_lire_epingle", _lire_epingle, user_id)


async def _epingler(api: ModuleApi, user_id: str, remplacer: bool) -> bool:
    """Épingle le descripteur courant de l'account data. ``False`` s'il n'y en a pas de valide."""
    descripteur = await _descripteur(api, user_id)
    if descripteur is None:
        return False
    await api.run_db_interaction(
        "tacita_ecrire_epingle", _ecrire_epingle, user_id, descripteur, remplacer
    )
    return True


def _cle_valide(cle_b64: Any, descripteur: dict[str, Any]) -> bool:
    """La clé soumise ouvre-t-elle ce descripteur ? Aucune exception ne sort d'ici."""
    if not isinstance(cle_b64, str):
        return False
    try:
        cle = b64decode(cle_b64, validate=True)
    except Exception:
        return False
    return len(cle) == 32 and _verifier_cle(cle, descripteur["iv"], descripteur["mac"])


class _RessourceConnexion(DirectServeJsonResource):
    """D-14 — **la porte de secours : la clé de récupération ouvre une session.**

    Elle est **exceptionnelle et le produit le dit** (``apps/web`` — écran de connexion).
    Ce qu'elle change au modèle de menace est écrit dans D-14 et dans
    Limite assumée : la clé cesse d'être un secret qui *déchiffre* pour devenir un
    secret qui *ouvre*. Qui la détient prend le compte, sans le mot de passe.

    Elle ne rend pas de jeton d'accès : elle rend un **jeton de connexion** à usage unique
    et à durée d'une minute, que le client échange sur ``/login`` par le chemin natif
    ``m.login.token``. Synapse crée alors l'appareil, applique ses propres limites et
    journalise la connexion comme n'importe quelle autre — un module qui fabriquerait le
    jeton d'accès lui-même se mettrait hors de tout ça.
    """

    def __init__(self, api: ModuleApi) -> None:
        super().__init__()
        self._api = api
        # Le limiteur de connexion du serveur, par IP, et non un compteur maison : c'est
        # celui que dimensionne, et un endpoint d'authentification qui ne
        # compte pas ses échecs n'a aucun moyen de voir qu'on l'essaie.
        self._limiteur = Ratelimiter(
            store=api._store,
            clock=api._clock,
            cfg=api._hs.config.ratelimiting.rc_login_address,
        )

    async def _async_render_POST(self, request: SynapseRequest) -> None:
        # Avant toute lecture : un échec doit coûter à celui qui le provoque. `ratelimit`
        # lève une `LimitExceededError`, que la couche HTTP rend en 429 avec son délai.
        await self._limiteur.ratelimit(None, request.getClientAddress().host)

        corps = parse_json_object_from_request(request)
        utilisateur = corps.get("user")
        if not isinstance(utilisateur, str) or not utilisateur:
            respond_with_json(request, 400, {"errcode": "M_MISSING_PARAM"}, send_cors=True)
            return

        user_id = self._api.get_qualified_user_id(utilisateur)
        if not await self._ouvrable(user_id, corps.get("recovery_key")):
            # **Un seul message pour toutes les causes** — compte inconnu, désactivé, sans
            # clé, ou clé fausse. Les distinguer donnerait un oracle de comptes à qui veut,
            # et cet endpoint est ouvert. Même jurisprudence que.
            respond_with_json(
                request,
                403,
                {
                    "errcode": "M_FORBIDDEN",
                    "error": "identifiant ou clé de récupération incorrect",
                },
                send_cors=True,
            )
            return

        # Une minute : ce jeton est consommé dans la seconde par l'appel `/login` qui suit.
        jeton = await self._api.create_login_token(user_id, duration_in_ms=60_000)
        respond_with_json(request, 200, {"login_token": jeton}, send_cors=True)

    async def _ouvrable(self, user_id: str, cle_b64: Any) -> bool:
        info = await self._api._store.get_user_by_id(user_id)
        if info is None or info.is_deactivated or getattr(info, "is_locked", False):
            # **Un compte désactivé ne se rouvre pas avec sa clé.** D-13 fait de la
            # désactivation la réponse à un compte indésirable ; sans cette ligne, cette
            # réponse-là se contournerait avec un secret que le compte détient déjà.
            return False

        descripteur = await _epingle(self._api, user_id)
        return descripteur is not None and _cle_valide(cle_b64, descripteur)


class _RessourceRemplacement(DirectServeJsonResource):
    """Ré-épingle la clé courante du compte, **mot de passe à l'appui**.

    Appelé par le client juste après une réinitialisation (« j'ai perdu ma clé ») : la
    nouvelle clé est déjà dans l'account data, mais le serveur continue de ne croire que
    l'ancienne tant que le titulaire n'a pas prouvé qu'il l'est. Un jeton volé ne connaît
    pas le mot de passe.
    """

    def __init__(self, api: ModuleApi) -> None:
        super().__init__()
        self._api = api
        # Par compte : c'est un oracle de mot de passe pour qui tient une session, il ne
        # doit pas coûter moins cher que `/login`.
        self._limiteur = Ratelimiter(
            store=api._store,
            clock=api._clock,
            cfg=api._hs.config.ratelimiting.rc_login_failed_attempts,
        )

    async def _async_render_POST(self, request: SynapseRequest) -> None:
        requester = await self._api.get_user_by_req(request)
        user_id = requester.user.to_string()
        await self._limiteur.ratelimit(None, user_id.lower())

        mot_de_passe = parse_json_object_from_request(request).get("password")
        if not isinstance(mot_de_passe, str) or not mot_de_passe:
            respond_with_json(request, 400, {"errcode": "M_MISSING_PARAM"}, send_cors=True)
            return

        if await self._api._auth_handler._check_local_password(user_id, mot_de_passe) is None:
            respond_with_json(
                request, 403, {"errcode": "M_FORBIDDEN", "error": "mot de passe incorrect"},
                send_cors=True,
            )
            return

        if not await _epingler(self._api, user_id, remplacer=True):
            respond_with_json(
                request,
                403,
                {"errcode": "M_FORBIDDEN", "error": "ce compte n'a pas de clé de récupération"},
                send_cors=True,
            )
            return
        respond_with_json(request, 200, {}, send_cors=True)


def create_module(config: Any, api: ModuleApi) -> None:  # noqa: ARG001
    api.register_web_resource("/_synapse/client/tacita/password", _Ressource(api))
    api.register_web_resource(
        "/_synapse/client/tacita/login_recovery", _RessourceConnexion(api)
    )
    api.register_web_resource(
        "/_synapse/client/tacita/recovery_key", _RessourceRemplacement(api)
    )

    async def ecriture(user_id: str, room_id: str | None, type_: str, contenu: Any) -> None:
        # Seule la **première** clé d'un compte s'épingle d'elle-même (`remplacer=False`) :
        # c'est l'inscription. Toute écriture suivante est ignorée ici.
        if room_id is None and (type_ == DEFAUT or type_.startswith(DESCRIPTION)):
            await _epingler(api, user_id, remplacer=False)

    api.register_account_data_callbacks(on_account_data_updated=ecriture)

    async def reprise() -> None:
        await api.run_db_interaction("tacita_reprise_epingles", _reprendre_existants)

    # Au démarrage, avant tout trafic utile : les comptes d'avant l'épingle la reçoivent
    # de leur account data du moment.
    api.delayed_background_call(0, reprise, desc="tacita_reprise_epingles")


class TacitaPassword:
    """Point d'entrée que `modules:` charge (`module: tacita_password.TacitaPassword`)."""

    def __init__(self, config: Any, api: ModuleApi) -> None:
        create_module(config, api)

    @staticmethod
    def parse_config(config: Any) -> Any:
        return config
