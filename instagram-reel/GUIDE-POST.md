# 📱 Poster le reel "3 sentiers cachés" sur Instagram

Ce dossier contient tout pour publier. Il te manque juste **le fichier vidéo** —
tu le génères en 30 secondes ci-dessous.

## 1. Générer la vidéo (avec la musique incluse)

1. Lance le serveur : `npm run dev:worker`
2. Ouvre **http://localhost:8787/promo** dans **Chrome** (ou Edge).
3. Clique **⏺ Enregistrer la vidéo**.
4. Dans la fenêtre de partage : choisis **« Cet onglet »** et **coche « Partager l'audio de l'onglet »** (essentiel pour avoir la musique).
5. Le reel se joue tout seul (~22 s), puis un fichier `bwr-reel-3-sentiers.webm`
   (ou `.mp4`) se télécharge automatiquement.
6. Déplace ce fichier ici, dans le dossier `instagram-reel/`.

> Pas d'enregistreur ? Filme l'écran avec **Win + Alt + R** (Xbox Game Bar) en plein
> écran (bouton ⛶), ou avec ton téléphone.

## 2. Convertir en MP4 si besoin

Instagram n'accepte pas le `.webm`. Si ton fichier est en `.webm` :
- Glisse-le dans **CapCut** (gratuit) puis **Exporter** → tu obtiens un `.mp4`, **OU**
- avec ffmpeg : `ffmpeg -i bwr-reel-3-sentiers.webm -c:v libx264 -c:a aac bwr-reel.mp4`

Format idéal Reel : **1080×1920 (9:16)**, MP4, H.264 + AAC.

## 3. (Option) Remplacer par une musique tendance

La vidéo a déjà une musique libre de droits. Si tu veux un **son tendance** :
- importe le `.mp4` dans l'éditeur **Reels** d'Instagram (ou CapCut) et ajoute le son
  depuis leur bibliothèque — c'est eux qui gèrent les droits.
- ou pré-charge ton propre fichier audio via le bouton **🎵 Remplacer la musique** sur la page avant d'enregistrer.

## 4. Publier

1. App Instagram → **+** → **Reel** → sélectionne `bwr-reel.mp4`.
2. Ouvre `CAPTION.txt`, copie-colle la légende + hashtags.
3. Mets ton lien BWR en **bio** et/ou en **commentaire épinglé**.
4. Publie 🚀

## 🎬 Reel #2 — « Trace ta boucle en 10 s » (démo de l'app)

Même procédure que ci-dessus, mais avec une **autre page** :

1. `npm run dev:worker`
2. Ouvre **http://localhost:8787/promo-demo** dans Chrome.
3. **⏺ Enregistrer la vidéo** → « Cet onglet » + coche « Partager l'audio de l'onglet ».
4. Le fichier `bwr-reel-trace-ta-boucle.webm` (ou `.mp4`) se télécharge (~22 s).
5. Convertis en MP4 si besoin (étape 2 ci-dessus).
6. Légende prête : **`CAPTION-2-boucle.txt`**.

Ce reel montre concrètement comment l'app crée un itinéraire boucle
(départ → boucle → 8 km → facile → tracé + distance/durée/dénivelé). Garde le
même style que le reel #1 pour faire « série ».

## Contenu du dossier
- `CAPTION.txt` — légende reel #1 (« 3 sentiers cachés »)
- `CAPTION-2-boucle.txt` — légende reel #2 (« Trace ta boucle »)
- `GUIDE-POST.md` — ce guide
- *(à ajouter)* `bwr-reel.mp4` / `bwr-reel-trace-ta-boucle.mp4` — les vidéos générées
