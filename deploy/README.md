# Deploy no EC2 (`/rpl/api`)

O backend não publica porta. O Caddy do frontend (`rpl-frontend`) repassa `/rpl/api/*`
para `rpl-backend:8010` pela rede do Caddy do `~/fortran` (`fortran_default`). O CSV fica
no MinIO, sempre na mesma chave (`rotas/rpl/rpl.csv`): cada upload substitui o anterior.

A cada push na `main`, `.github/workflows/deploy.yml` confere o código, entra no EC2 por
SSH e roda `deploy/atualizar.sh`: `git pull`, `docker compose up -d --build`, conferência.

## Uma vez no EC2

```bash
git clone https://github.com/lfcr9311/rpl-s3-uploader-backend.git ~/rpl-s3-uploader-backend
```

O `.env` é opcional. Crie um em `~/rpl-s3-uploader-backend/.env` só para mudar o padrão:
- `MINIO_ENDPOINT` (padrão `http://3.137.219.87:9000`), `MINIO_BUCKET` (padrão `rotas`),
  `MINIO_KEY` (padrão `rpl/rpl.csv`)
- `MINIO_ACCESS_KEY` e `MINIO_SECRET_KEY`: sem elas o acesso é anônimo, e o bucket precisa
  permitir leitura e escrita públicas

A tela e a API não têm senha: quem acessa `/rpl` pode ver os voos e trocar o arquivo.

## Uma vez no seu computador

Chave só para o deploy, limitada a rodar o `atualizar.sh` deste repositório:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gh_deploy_rpl_backend -N "" -C github-actions-deploy-rpl-backend
echo "command=\"bash ~/rpl-s3-uploader-backend/deploy/atualizar.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat ~/.ssh/gh_deploy_rpl_backend.pub)" \
  | ssh -i ~/CHAVE.pem -o IdentitiesOnly=yes ubuntu@ec2-3-137-219-87.us-east-2.compute.amazonaws.com 'cat >> ~/.ssh/authorized_keys'
```

`-o IdentitiesOnly=yes` garante que o ssh use só a chave indicada. Sem isso, ele pode usar
a chave de deploy de outro projeto, e essa dispara o deploy dele.

## Uma vez no GitHub: secrets

```bash
R=lfcr9311/rpl-s3-uploader-backend
H=ec2-3-137-219-87.us-east-2.compute.amazonaws.com
gh secret set EC2_HOST -R $R -b "$H"
gh secret set EC2_USER -R $R -b "ubuntu"
gh secret set EC2_SSH_KEY -R $R < ~/.ssh/gh_deploy_rpl_backend
ssh-keyscan -t ed25519 $H | gh secret set EC2_KNOWN_HOSTS -R $R
```

## Dia a dia

No EC2, em `~/rpl-s3-uploader-backend`:
- `docker compose logs -f rpl-backend`: log do servidor
- `bash deploy/atualizar.sh`: o mesmo deploy, rodado à mão
- mudou o `.env`: `docker compose up -d --force-recreate`
