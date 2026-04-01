<div align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" alt="ZapMax" width="120">

  <h1>ZapMax Workspace</h1>
  
  <p>
    <strong>Sistema Master de Gestão e Atendimento Multi-Usuários para WhatsApp</strong>
  </p>

  <p>
    <img alt="Versão" src="https://img.shields.io/badge/version-1.0.0-blue.svg?cacheSeconds=2592000" />
    <img alt="Node Version" src="https://img.shields.io/badge/node-%3E%3D%2018.0.0-brightgreen.svg" />
    <img alt="Controle" src="https://img.shields.io/badge/Electron-Desktop-47848f.svg" />
    <img alt="Banco" src="https://img.shields.io/badge/SQLite-WAL_Optimized-003B57.svg" />
    <img alt="API" src="https://img.shields.io/badge/wwebjs-Headless-25D366.svg" />
  </p>
</div>

---

## 📑 Índice

- [📖 Visão Geral Completa](#-visão-geral-completa)
- [✨ Features e Funcionalidades](#-features-e-funcionalidades)
  - [👥 Gestão de Atendimento (Multi-Agente)](#-gestão-de-atendimento-multi-agente)
  - [🤖 Automações e Inteligência Artificial](#-automações-e-inteligência-artificial)
  - [📊 Mini-CRM e Contatos](#-mini-crm-e-contatos)
  - [🔒 UI, Segurança e Admin](#-ui-segurança-e-admin)
- [🏗 Estritetura e Stack Tecnológico](#-arquitetura-e-stack-tecnológico)
- [📦 Estrutura do Monorepo](#-estrutura-do-monorepo)
- [🚀 Instruções de Instalação e Uso](#-instruções-de-instalação-e-uso)
- [💻 Como Compilar e Empacotar (Build)](#-como-compilar-e-empacotar-build)
- [🗄️ Otimizações de Banco de Dados](#️-otimizações-de-banco-de-dados)
- [📸 Interface e Screenshots](#-interface-e-screenshots)

---

## 📖 Visão Geral Completa

O **ZapMax** foi construído do zero para resolver os limites impostos pelo WhatsApp padrão e fornecer um centro de operações unificado para equipes de vendas e suporte ao cliente. 

O sistema orquestra uma única conta de WhatsApp através de uma estrutura **Client-Server robusta empacotada em Electron**, permitindo que sua equipe opere simultaneamente sem causar conflitos ou quedas de conexão. Com uma engine própria e otimizações pesadas de SQLite e `whatsapp-web.js`, a plataforma processa milhares de mídias e conversas com eficiência, rodando nativamente como um sistema Desktop completo e autossuficiente (sem depender da nuvem).

---

## ✨ Features e Funcionalidades

### 👥 Gestão de Atendimento (Multi-Agente)
- **Operação Simultânea Real:** Um número infinito de atendentes pode responder aos clientes sem os atrasos da versão "Dispositivos Conectados" oficial.
- **Transferência Instantânea In-App:** O atendente 'A' transfere a conversa para o 'B'. O atendente 'B' recebe notificações na hora e adquire uma badget visual de "novo lido/não-lido" sem recarregar a tela.
- **Modo Vizualização de "Convidado":** Mesmo que uma conversa esteja sob controle de um setor, usuários convidados ou administradores podem ver o andamento, ler mensagens passadas e interagir livremente se necessário.
- **Fechamento e Ciclo de Vida do Ticket:** Tickets podem ser concluídos, fechando a aba de atendimento. O sistema "recria" o atendimento magicamente no exato momento que o cliente enviar uma nova mensagem.
- **Ações Rápidas em Lote (Bulk Actions):** Segure `Ctrl` e clique nos atendimentos da fila esquerda. Você poderá fechar conversas travadas, deletar e transferir dezenas de clientes ao mesmo tempo.

### 🤖 Automações e Inteligência Artificial
- **Integração com IA Groq (`groq-sdk`):** Ganchos embutidos e prontos para alimentar a IA e gerar sumários e respostas automatizadas ultra-rápidas usando as LLMs via Groq Cloud.
- **Gatilhos Mágicos:** Comandos textuais disparados por clientes podem responder documentos completos em PDF, mídias e links automáticamente.
- **Aviso de Ausência e Horário Comercial:** Se a sua empresa for almoçar, o ZapMax ativa um aviso robótico "Estaremos de volta as 13:00!" sem precisar desligar o computador.

### 📊 Mini-CRM e Contatos
- **Guia de Contatos (Address Book):** Localize qualquer cliente usando nossa barra de busca indexada, sem precisar salvar a pessoa no seu celular.
- **Agendamento e Início Ativo:** Comece um chat diretamente procurando o número dentro do guia, antes mesmo do cliente iniciar a conversa.
- **Extração Completa e Rápida (.CSV):** Seus leads são seus. Clique no botão de download, e todo o banco da empresa é extraído num CSV perfeitamente compatível com o **Google Contacts** (você pode levá-los para qualquer celular em segundos).
- **Armazenamento Seguro de Avatares:** Os avatares de milhares de usuários são convertidos da internet e persistidos no disco HD, cortando a dependência da rede e poupando banda e bateria.

### 🔒 UI, Segurança e Admin
- **Painel de Configuração Embutido (Slide-In):** Como no iPhone ou em Apps modernos do Windows, as configurações "deslizam" pra tela. Configure setores, admins e filas sem ir pra outra aba do navegador.
- **Painel de Autenticação Duplo:** Usuários operacionais x Administradores Gerais usando `Bcryptjs` para as senhas criptografadas e `jsonwebtoken (JWT)` nas conexões de socket.

---

## 🏗 Arquitetura e Stack Tecnológico

Criado para Windows (podendo exportar pra Mac/Linux), utiliza as tecnologias top de mercado de 2024–2025 focado estritamente em **velocidade Desktop**.

1. **Back-end Server:** `Node.js` + `Express` + `whatsapp-web.js`.
2. **Conexões em Tempo Real WebSockets:** Transmissão instantânea de mensagens e ticks azuis coordenados via `Socket.IO`.
3. **Persistência Relacional Veloz:** `SQLite3`, configurado nativamente com PRAGMAs do tipo **Write-Ahead Logging (WAL)**, impedindo contenção entre leitura-escrita nos bancos de mensagens.
4. **App Wrapper (Frontend + Servidor Embarcado):** Rodando tudo de uma só vez numa janela unificada usando o `Electron`.
5. **Autenticação:** `bcryptjs` + `jsonwebtoken`.
6. **IA Engine:** `groq-sdk`.
7. **File System Manager:** `Multer` e Módulos Nativos para manipulação e separação de BLOBs (imagens/áudio/vídeo) sem arrastar o banco de dados.

---

## 📦 Estrutura do Monorepo

O código-fonte segue a separação lógica dentro da pasta raiz:

```bash
📂 SISTEMA-WHATSAPP-MULTI/
├── 📂 apps/
│   ├── 📂 client/           # O Frontend puro do sistema (Telas, React/HTML/JS)
│   └── 📂 server/           # O Backend Node.js de processamento da API
├── 📂 .agent/               # Scripts arquiteturais de IA e documentação interna
├── 📄 package.json          # Orquestração das dependências
├── 📄 electron-builder-*.json # Regras de compilação da build Client x Server
└── 📄 index.js              # Inicializador Root
```

---

## 🚀 Instruções de Instalação e Uso

### Dependências Iniciais
- **[Instalar o Git](https://git-scm.com/downloads)**
- **[Instalar o NodeJS (Versão 18 ou 20 LTS)](https://nodejs.org/)**

### 1️⃣ Inicialização do Ambiente (Desenvolvimento)
Abra seu terminal e baixe os arquivos caso não possua localmente ainda:
```bash
git clone https://github.com/tangoplaybr/zapmax.git
cd zapmax
npm install
```

### 2️⃣ Rodando pela Primeira Vez
O sistema exige que o Back-end inicie primeiro e o Front-end apenas se conecte a ele.

Abra **DUAS ABAS** (ou dois terminais divididos) no VS Code.

* No terminal 1, inicie o core do sistema:
  ```bash
  npm run start:server
  ```
  *(🔑 IMPORTANTE: Na primeira vez, um **QR CODE** aparecerá nesse terminal. Pegue o celular oficial que será usado e escaneie o código igual ao WhatsApp Web, aguarde a mensagem de SESSÃO PRONTA).*

* No terminal 2, abra a Interface de Usuário:
  ```bash
  npm run start:client
  ```

Pronto, pode começar a criar seus usuários e configurar os setores de atendimento! 🎉

---

## 💻 Como Compilar e Empacotar (Build)

Quando tudo estiver pronto para ser colocado "nas máquinas das empresas ou lojas de suporte", não podemos entregar código cru. Vamos empacotar para gerar os instaladores "``.exe``" nativos:

```bash
# Isso gera o compilado de Motor Servidor do ZapMax
npm run build:server

# E Isso gera a interface cliente a ser instalada nos Windows dos atendentes
npm run build:client
```
Os arquivos gerados irão aparecer na pasta de distribuição (geralmente `dist/` ou `release/`).

---

## 🗄️ Otimizações de Banco de Dados
Evitamos usar MongoDB/MySQL localmente para não exigir instalação externa nas máquinas dos usuários. O `SQLite` está rodando com `WAL Mode` (escrita isolada) e indexação pesada em Múltiplas Tables/Unions (mensagens, guias de contatos), de modo que o sistema retorne 10 mil contatos de uma base corporativa em menos de 2 milissegundos nas buscas. O cache da tela salva a rede de repetidas chamadas.

---

## 📸 Interface e Screenshots

> *(Substitua no GitHub após subir os arquivos de prints)*

| Tela de Login | Painel de Atendimento (Chat) | Configurações Admin |
|:---:|:---:|:---:|
| <img src="https://via.placeholder.com/350x200.png?text=Login+ZapMax" alt="Login"> | <img src="https://via.placeholder.com/350x200.png?text=Chat+Em+Tempo+Real" alt="Chat"> | <img src="https://via.placeholder.com/350x200.png?text=In-App+Admin" alt="Admin"> |

---

<div align="center">
  <b>Elaborado com dedicação e velocidade em 2026. Feito para turbinar as vendas da sua companhia.</b>
  <br><br>
  <i>(Atenção: A biblioteca de WhatsApp que usamos é mantida pela comunidade e exige conformidade com as políticas corporativas da Meta/WhatsApp).</i>
</div>
