# Royal Spin — casino multijoueur (points virtuels)

Projet de 2ᵉ année génie informatique. Application web temps réel : **roulette** multijoueur, **blackjack**, **machine à sous**, classement et **mode écran géant** pour projeter la partie.

> Aucun argent réel : tout se joue en points virtuels (1 000 points au départ).

## Lancer en local

```bash
npm install
npm start
```

Le terminal affiche trois adresses :

| Page | Adresse | Usage |
|------|---------|-------|
| Croupier | `http://localhost:3000/host` | lancer la roue, mode automatique, statistiques |
| Écran géant | `http://localhost:3000/tv` | à projeter : roue, classement, QR code |
| Joueurs | `http://<IP du PC>:3000` | les téléphones (même WiFi) scannent le QR code |

Si le QR code pointe vers une mauvaise adresse (carte réseau virtuelle), choisissez la bonne dans la liste déroulante de la page croupier.

## Fonctionnalités

- Roulette européenne (0-36) : numéro plein (×36), rouge/noir, pair/impair, manque/passe, douzaines et colonnes
- Roue animée (canvas), sons (WebAudio), confettis, historique, numéros chauds/froids
- Blackjack contre le croupier (blackjack paie 3 pour 2, doubler)
- Machine à sous (jackpot ×250)
- Niveaux, badges et classement en direct
- Mode automatique : compte à rebours, tirage et nouveau tour sans intervention
- Sauvegarde des joueurs dans `data.json`
- Installable sur téléphone (PWA)

## Architecture

```
lib/game.js        Toute la logique côté serveur (paris, tirage, gains, blackjack, slots).
api/rpc.js         Fonction Vercel : POST /api/rpc.
server.js          Serveur local Express (npm start).
public/
  index.html       page joueur            js/player.js
  tv.html          écran géant            js/tv.js
  host.html        croupier + stats       js/host.js
  js/shared.js     roue canvas, audio, confettis
  css/casino.css   thème
```

- **Temps réel** : interrogation HTTP (`rs-socket.js`) avec les mêmes événements qu'avant (`bet`, `spin`, `state`, `me`…). L'état public est diffusé à tous, l'état privé (mises, main de blackjack) uniquement au joueur concerné.
- **Anti-triche** : le client n'envoie que des intentions. Le serveur valide chaque mise (type, montant, solde), tire le numéro avec `crypto.randomInt` et calcule les gains. Les cartes du croupier restent cachées tant que la main n'est pas terminée.
- **Droits du croupier** : seul `localhost` (ou la clé `HOST_KEY` en ligne) peut lancer la roue ou réinitialiser.
- **Persistance** : un document JSON dans Redis (en ligne) ou `data.json` (local).

## Mettre en ligne sur Vercel (gratuit)

Cette version n'utilise plus Socket.IO ni de serveur permanent : les clients interrogent `POST /api/rpc` (voir `public/rs-socket.js`) et tout l'état de la partie est stocké dans **Upstash Redis**. Les temporisations (décompte, tirage, résultat) sont calculées à partir d'horodatages, donc rien ne dépend d'un `setTimeout` côté serveur.

1. Envoyez le contenu de ce dossier **à la racine** d'un dépôt GitHub (`package.json` et `vercel.json` doivent être visibles à la racine).
2. Sur Vercel : **Add New > Project**, choisissez le dépôt. `vercel.json` désactive le preset Express (`framework: null`) et publie `public/`. Si Vercel affiche encore « Express », réglez **Application Preset = Other**.
3. Avant **Deploy**, ajoutez **Environment Variables** :
   - `HOST_KEY` : mot de passe du croupier (page `/host`).
   - `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN` : créés sur upstash.com (Redis, région proche, gratuit) > onglet *REST API*. Les variables `KV_REST_API_URL` / `KV_REST_API_TOKEN` (intégration Vercel Marketplace) fonctionnent aussi.
4. Deploy. Ouvrez `https://<projet>.vercel.app/host` (clé `HOST_KEY`), puis `/tv` sur le projecteur. Les joueurs scannent le QR code.

Limites : la roulette se met à jour par interrogation toutes les ~1,5 s (6 s si l'onglet est caché). Chaque interrogation coûte environ 3 commandes Redis : le quota gratuit Upstash suffit pour des parties de quelques dizaines de joueurs, pas pour un usage permanent. Les tirages et décomptes n'avancent que si quelqu'un (l'écran TV par exemple) garde la page ouverte.

## Alternative : Render

`render.yaml` reste valide : `npm start` lance `server.js` (Express + `/api/rpc`, stockage `data.json`, ou Redis si les variables sont définies).

Variables d'environnement : `PORT`, `HOST_KEY`, `PUBLIC_URL`, `DATA_FILE`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `SPIN_MS`, `RESULT_MS`.
