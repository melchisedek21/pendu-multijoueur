# Pendu Multijoueur (Classique + Imposteur)

Une version en ligne du jeu du Pendu, jouable a plusieurs (jusqu'a 6 joueurs) depuis n'importe quel navigateur — PC, tablette ou telephone — avec comptes utilisateurs et deux modes de jeu.

Projet realise par Mel, en extension du projet Pendu original (version terminal Python), dans le cadre de l'apprentissage du developpement web, des WebSockets et du deploiement en ligne.

## Modes de jeu

### Classique (cooperatif)
Tous les joueurs devinent le meme mot ensemble, a tour de role. Chacun propose une lettre quand c'est son tour. La partie se termine quand le mot est trouve ou que le nombre d'erreurs maximum est atteint.

### Imposteur
- 3 a 6 joueurs
- Un mot secret est choisi. **Les innocents connaissent le mot**, mais **1 ou 2 imposteurs** (selon le nombre de joueurs) **ne le connaissent pas**
- A tour de role, chacun propose une lettre — les innocents proposent normalement les vraies lettres, l'imposteur doit deviner a l'aveugle sans se faire reperer
- Une fois le mot trouve (ou les erreurs maximum atteintes), **phase de vote** : chaque joueur designe qui il pense etre l'imposteur
- Les innocents gagnent s'ils designent correctement un imposteur reel ; sinon, l'imposteur gagne

## Fonctionnalites

- Comptes utilisateurs (inscription/connexion), mots de passe hashes avec bcrypt
- Creation de salle avec code a 5 caracteres, jusqu'a 6 joueurs
- Jeu en temps reel via WebSockets
- 3 categories de mots, 3 niveaux de difficulte
- Systeme de score (mode classique)
- Interface jouable au navigateur, sans installation, sur tout appareil

## Structure du projet

```
pendu_multijoueur/
├── main.py                # Point d'entree FastAPI (routes API + WebSocket)
├── database.py             # Configuration SQLAlchemy (SQLite en local, PostgreSQL en prod)
├── models.py                # Modeles Utilisateur et Score
├── auth.py                  # Hashage des mots de passe, jetons JWT
├── game_logic.py             # Categories de mots, difficulte, calcul du score
├── websocket_manager.py       # Gestion des salles, des roles et des votes
├── requirements.txt
├── .env.example
├── .gitignore
└── static/
    ├── index.html
    ├── app.js
    └── style.css
```

## Installation et lancement en local

```bash
cd pendu_multijoueur
pip3 install -r requirements.txt --break-system-packages
cp .env.example .env
# Modifie .env si besoin (SECRET_KEY notamment)
uvicorn main:app --reload
```

Ouvre ensuite `http://localhost:8000` dans ton navigateur.

Pour tester le multijoueur en local, ouvre une deuxieme fenetre de navigateur (ou un navigateur different) avec un deuxieme compte, et rejoins la meme salle avec le code affiche.

## Deploiement sur Render

1. Pousse ce projet sur GitHub
2. Cree un compte sur [render.com](https://render.com) et connecte ton depot
3. Cree un nouveau "Web Service" pointant vers ce depot
4. Commande de build : `pip install -r requirements.txt`
5. Commande de demarrage : `uvicorn main:app --host 0.0.0.0 --port $PORT`
6. Ajoute les variables d'environnement `SECRET_KEY` (une longue chaine aleatoire) et `DATABASE_URL`
7. (Recommande) Cree une base PostgreSQL gratuite sur Render et utilise son URL comme `DATABASE_URL`

Une fois deploye, l'URL fournie par Render est accessible depuis n'importe quel appareil connecte a internet — telephone et tablette inclus, directement dans le navigateur.

## Limites connues (a garder en tete)

- Les salles sont stockees **en memoire** : si le serveur redemarre, toutes les parties en cours sont perdues (les comptes utilisateurs et scores, eux, restent en base de donnees)
- Pas de gestion avancee des deconnexions en pleine partie (le jeu continue, mais le joueur deconnecte ne peut plus jouer son tour)
- Pas encore de limite de temps par tour

## Ameliorations possibles

- Limite de temps par tour (surtout utile en mode Imposteur, pour eviter qu'un joueur reflechisse trop longtemps)
- Historique des parties jouees par utilisateur
- Systeme de classement global
- Chat textuel entre joueurs pendant la partie