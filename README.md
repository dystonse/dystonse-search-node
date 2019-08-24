Offenbar habe ich vor 2 Jahren das letzte Mal an dystonse gearbeitet, und nicht ordentlich archiviert. 

Was ich habe (oder irgendwo haben müsste):
 * Tweets unter @dystonse
 * Quasi leeres Repo unter https://github.com/lenaschimmel/dystonse
 * Repo mit etwas Info und Code unter https://github.com/lenaschimmel/dystonse-tools
 * Irgendwo die gesammelten Echtzeit-Daten von 2017 als MySQL-Tabelle, etwas über 3 GB
 * Meine "wissenschaftliches" Notizen für die Masterarbeit, die auch irgendwann mal online waren
 * Sehr vielversprechende tools von derhuerst

Wenn ich die tools / daten / apis / formate von derhuerst nutzen will, sollte auch meine Software in JS geschrieben 
sein. Andere naheliegende Sprachen wären sonst Java, C++, Dart.

Offenbar gab's sogar schonmal einen sehr ähnlichen Ansatz beim einem Hackaton in 2018, der aber nicht zuende geführt
 wurde: https://github.com/derhuerst/predict-vbb-delays/blob/master/docs/story.md

Lange liste mit ÖPNV-Projekten: https://github.com/CUTR-at-USF/awesome-transit#awesome-transit-

vbb-map-routing ist eine halbwegs funktionierebde Website mit Karte, die Start und Ziel per Klick auswählen lässt,
 und eine Journey als Liste und auf der Karte anzeigt. Die Jorney wird derzeit mit dem vbb-client erzeugt, also per 
 Anfrage an den Server der VBB.

Idee: Wenn ich ein Modul mache, das vbb-client.journeys() implementiert, dann kann ich die vorhandenen Tools
nutzen, um die Ergebnisse anzuzeigen.

Die Spezifikation von Journeys sieht aber natürlich keine Wahrscheinlichkeiten und Alternativen vor. Wie würde denn
eine dystone-Journey aussehen?

Die erste Stufe könnte natürlich sein, für eine einzelne (ggf. fremd-berechnete) Journey zu annotieren, wie
die Ankufts- und Abfahrtswahrscheinlichkeiten an den einzelnen Stellen aussehen.

#####

Machen wir uns doch mal ein kleines Mini-Metro-Netz mit Abfahrtszeiten, etc. Von meinem Startpunkt aus kann ich 
in verschiedene Linien einsteigen, und für jede ergeben sich Wahrscheinlichkeiten, wann ich wo sein kann. Dabei 
kann ich alle Stationen ignorieren, die weder Start, noch Ziel, noch potentielle Umsteigestation sind. Andererseits
könnten mehrere Zwischenstops potentielle Zielhaltestellen sein, von denen aus ich zum eigentlichen Ziel laufen kann.

Für jede potentielle Umsteigestation kann ich dann wieder eine solche Suche machen nur, nur eben nicht mit einem
konkreten Startzeitpunkt, sondern mit der jeweiligen Verteilung. Das könnte ich als rekursiven Aufruf machen, 
und hätte somit alle relevanten Daten im Stack. Allerdings wäre das Depth-first und würde sehr lange brauchen,
bis die ideale Route ermittelt ist.

Ich brauche also eine Menge von möglichen Abfahrten, die es zu betrachten gilt, und aus denen ich heuristisch
die vielversprechendste heraus suchen kann. Die Heuristik könnte sein: Wann bin ich von da aus zu Fuß am Ziel? 
Aber selbst bei deterministischer Fußwegzeit hätte ich hier nur Verteilungen, die keine Totalordnung darstellen.
Also vielleicht der Erwartungswert?

Für einen möglichen Ausstieg berechne ich also den Erwartungswert meiner Ankunft und die Entfernung zum Ziel,
addiere die Laufzeit auf die Ankunft und nehme das als Priorität. Das Objekt, das ich hinterlege, ist die
Historie, wie ich dort hin gelangt bin.