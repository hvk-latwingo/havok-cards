# Havok Cards — déploiement Netlify + Supabase

Contenu du dossier :

| Fichier | Rôle |
|---|---|
| `index.html` | Le site complet (cartes, boosters, boutique, espace gérant, espace admin) |
| `hv.js` | Connexion à Supabase : comptes, synchronisation, outils gérant/admin |
| `config.js` | **À remplir** : URL et clé « anon » de votre projet Supabase |
| `netlify.toml` | Réglages Netlify (aucun build nécessaire) |
| `supabase/schema.sql` | Base de données + règles de sécurité à exécuter une fois |

## 1. Supabase (≈ 5 min)

1. Créez un projet sur <https://supabase.com>.
2. **SQL Editor → New query** : collez tout `supabase/schema.sql`, puis **Run**.
   (Il crée les tables, les rôles, les règles de sécurité RLS, le stockage d'images `cards` et le temps réel.)
3. **Authentication → Providers → Email** : pour que l'inscription soit immédiate, désactivez *Confirm email*
   (sinon les joueurs doivent d'abord cliquer sur le lien reçu par e-mail).
4. **Authentication → URL Configuration** : mettez l'adresse Netlify de votre site dans *Site URL* (une fois connue, voir §3).
5. **Project Settings → API** : notez *Project URL* et la clé *anon public*.

## 2. Configuration

Ouvrez `config.js` et renseignez les deux valeurs :

```js
window.HV_CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJ..."   // clé anon / public
};
```
La clé *anon* est publique par conception. **Ne mettez jamais la clé `service_role` dans le site.**

## 3. Netlify

- Le plus simple : <https://app.netlify.com/drop> → glissez-déposez le dossier (sans le `README`, c'est facultatif).
- Ou : *Add new site → Import from Git*, avec ce dossier dans un dépôt ; *Build command* vide, *Publish directory* = `.`.

Le fichier `index.html` fait ~11 Mo (toutes les cartes sont intégrées) : le premier chargement est plus long, ensuite il est mis en cache.

## 4. Premier administrateur

1. Ouvrez votre site et **créez un compte** (écran de connexion → « Créer un compte »).
2. Dans Supabase → SQL Editor, exécutez (avec votre e-mail) :

```sql
update public.profiles set role = 'admin' where email = 'vous@exemple.com';
```
3. Rechargez le site : *Compte* affiche maintenant **Espace gérant** et **Espace admin**.

## 5. Les trois rôles

| | Joueur | Gérant (`manager`) | Admin (`admin`) |
|---|:--:|:--:|:--:|
| Jouer, collectionner, échanger | ✅ | ✅ | ✅ |
| Créer / désactiver des cartes (image incluse) | – | ✅ | ✅ |
| Créer / modifier / supprimer des boosters | – | ✅ | ✅ |
| Masquer des cartes ou boosters intégrés | – | ✅ | ✅ |
| Régler les probabilités de tirage par rareté | – | ✅ | ✅ |
| Voir et gérer les comptes (rôle, suspension) | – | – | ✅ |
| Envoyer des cadeaux (points, boosters) | – | – | ✅ |
| Réglages (boosters par jour, prix des lots) | – | – | ✅ |
| Voir les statistiques et le journal | – | – | ✅ |

Pour nommer un gérant : un admin ouvre **Espace admin → Joueurs**, choisit le rôle `manager` dans la liste du joueur.
Les droits sont appliqués **par la base de données** (RLS), pas seulement par l'interface : un joueur qui bidouille le site ne peut pas créer de carte.

## 6. Créer du contenu

**Carte** (Espace gérant → Cartes) : nom, rareté, image (portrait ≈ 500×700 px, coins arrondis transparents de préférence, redimensionnée en WebP 640 px à l'envoi), attaque/défense (vides = calcul automatique) et étiquette facultative.
Ensuite la carte doit être mise dans un ou plusieurs boosters : **sans booster actif, elle n'est ni tirable ni visible des joueurs** (elle apparaît « indisponible » dans votre liste).

> Le booster **Havok** ne contient que les **53 cartes originales** (n° 0 à 52 : Havok, Wox, Pixie, Tjino, Idrop, Pixx, Seekk, Wazz, Zetfar, les 7 cartes Rare du staff, Rainbow et les 3 Collector). Les cartes du staff redessinées sont dans **Staff**, les armes et objets dans **Fortnite**, et vos nouvelles cartes dans les boosters que vous créez.

**Booster** (Espace gérant → Boosters) : identifiant, nom, description, ruban, 4 couleurs, et soit *toutes les cartes*, soit une *sélection* (3 minimum). L'aperçu du paquet utilise automatiquement les 3 cartes les plus rares de la sélection. Vous pouvez fixer des dates de début/fin pour un événement.

**Masquer une carte ou un booster** (par exemple pour la rendre plus rare) :
- Une carte **masquée / désactivée** (ou dont le booster est masqué, inactif ou hors des dates de l'événement) **ne sort plus** dans les boosters et **disparaît de l'album** des joueurs qui ne l'ont pas. Elle ne compte plus dans leurs totaux ni dans leurs missions.
- Les joueurs qui **l'ont déjà la gardent** : elle reste dans leur album, leurs doubles, leurs échanges et leur vitrine.
- Masquer un booster retire aussi ses **cartes exclusives** (celles qui ne sont dans aucun autre booster actif). Les cartes qui sont aussi dans un autre booster actif restent disponibles.
- Tout est **réversible** : en réactivant la carte ou le booster, tout redevient visible.

> ⚠️ **Ne supprimez jamais une carte directement dans Supabase** : le numéro d'une carte dépend de l'ordre des cartes créées. Utilisez « Désactiver » à la place (les joueurs qui la possèdent la gardent).

## 7. Limites à connaître (honnêteté)

- **Triche possible.** La logique du jeu (tirages, points, boosters du jour) tourne dans le navigateur ; chaque joueur peut modifier sa propre sauvegarde via l'API. Pour une communauté de fans c'est acceptable ; pour un vrai anti-triche il faudrait déplacer les tirages dans des fonctions serveur (Supabase Edge Functions / RPC). L'import de sauvegarde est signé, mais cette signature est contournable par un développeur motivé.
- Les échanges se valident quand les **deux** joueurs ouvrent l'app (pas de serveur central).
- Les profils publics, classement et échanges sont lisibles par tous les joueurs connectés (l'e-mail, lui, n'est visible que du joueur et des admins).
- Les cartes **intégrées** (les 115 d'origine) restent dans `index.html` ; seules les nouvelles cartes passent par la base. Elles sont masquables mais pas modifiables depuis l'interface.
- La version testée de la bibliothèque Supabase est `supabase-js 2.39.7` (chargée depuis jsDelivr dans `index.html`).

## 8. Dépannage

- **Écran de connexion absent** : `config.js` est vide ou mal rempli.
- **« row-level security » à la création d'une carte** : votre compte n'est pas `manager`/`admin` (vérifiez la table `profiles`).
- **Image de carte qui n'apparaît pas** : vérifiez que le bucket `cards` existe et est *public* (Storage).
- **Le classement ne se met pas à jour en direct** : exécutez la fin de `schema.sql` (publication `supabase_realtime`) ; sinon il se rafraîchit toutes les 30 s.
- **Compte suspendu** : un admin peut le réactiver dans *Espace admin → Joueurs*.

## Duels en direct (nouveau)
- Ré-exécutez `supabase/schema.sql` en entier (il est rejouable) : il crée la table `duels` (RLS + temps réel).
- Déposez aussi `live.js` à côté de `index.html` (Netlify : glisser-déposer tout le dossier).
- Dans l'app : Duel → « 🌐 Duel en direct » : un joueur crée un duel, l'autre le rejoint depuis la liste (duels ouverts < 15 min). 5 manches, cartes jouées en même temps, ⚡ Super 1 fois.
- Victoire en direct : +15⭐ (3 par jour max, 2 manches minimum). Abandon possible ; forfait réclamable si l'adversaire est inactif depuis 90 s.
- Limite assumée : les règles sont calculées par les navigateurs (comme les tirages), pas par le serveur.
- Les anciens duels terminés restent en base : vous pouvez les purger de temps en temps (`delete from public.duels where updated_at < now() - interval '1 day';`).
