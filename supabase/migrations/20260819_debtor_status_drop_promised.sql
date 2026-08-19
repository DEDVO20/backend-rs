-- Se consolidan los estados "Prometido" (promised) y "Acuerdo" (agreement) del
-- deudor: eran casi equivalentes en la operación. Se conserva "agreement" y se
-- reclasifican los deudores que estuvieran marcados como "promised".
update collection_debtors set status = 'agreement' where status = 'promised';
