use std::{os::fd::AsRawFd, sync::Arc, time::Duration};

use crate::{
    broker::Broker,
    protocol::{HostResult, RuntimeCommand},
    runtime::Runtime,
    service::handle,
};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    time::{Instant, sleep, timeout},
};

#[tokio::test]
async fn reset_client_does_not_cancel_admitted_owned_work() {
    let directory = tempfile::tempdir().unwrap();
    let script = directory.path().join("runtime.mjs");
    std::fs::write(&script, r#"
      import {createInterface} from 'node:readline';
      import {writeFileSync} from 'node:fs';
      import {join} from 'node:path';
      const state=process.argv[2];
      const emit=(id,event)=>process.stdout.write(JSON.stringify({version:1,id,event})+'\n');
      createInterface({input:process.stdin}).on('line',line=>{
        const {id,command}=JSON.parse(line);
        if(command.type==='logout'){
          emit(id,{type:'notice',task_id:null,text:'Synthetic owned work started'});
          emit(id,{type:'host_call',call_id:'11111111-1111-4111-8111-111111111111',command:{
            type:'exec',program:process.execPath,args:['--eval',
              `const {writeFileSync}=require('node:fs');writeFileSync(${JSON.stringify(join(state,'started'))},'yes');setTimeout(()=>writeFileSync(${JSON.stringify(join(state,'finished'))},'yes'),800)`],
            cwd:state,timeout_seconds:5}});
        }else if(command.type==='host_reply'){
          writeFileSync(join(state,'reply.json'),JSON.stringify(command.result));
          emit(id,{type:'auth_status',status:{state:'signed_out'}});emit(id,{type:'done'});
        }
      });
    "#).unwrap();
    let runtime = Arc::new(Runtime::start(&script, directory.path()).unwrap());
    let broker = Arc::new(Broker::new(None, directory.path()).unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut client = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (server, _) = listener.accept().await.unwrap();
    let owner = runtime.clone();
    let mut handler = tokio::spawn(async move { handle(server, owner, broker).await });
    let observe = async {
        let mut command = serde_json::to_vec(&RuntimeCommand::Logout).unwrap();
        command.push(b'\n');
        client.write_all(&command).await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !directory.path().join("started").exists() {
            assert!(Instant::now() < deadline);
            sleep(Duration::from_millis(10)).await;
        }
        // A real TCP reset with the delivered Notice unread, rather than an orderly EOF.
        let linger = libc::linger {
            l_onoff: 1,
            l_linger: 0,
        };
        assert_eq!(
            unsafe {
                libc::setsockopt(
                    client.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_LINGER,
                    std::ptr::from_ref(&linger).cast(),
                    std::mem::size_of::<libc::linger>().try_into().unwrap(),
                )
            },
            0
        );
        drop(client);
        // Done follows the fixture's complete write. File creation alone can
        // expose a zero-byte receipt while writeFileSync is still publishing it.
        (&mut handler).await
    };
    let observed = timeout(Duration::from_secs(8), observe).await;
    if observed.is_err() {
        handler.abort();
        let _ = handler.await;
    }
    match Arc::try_unwrap(runtime) {
        Ok(runtime) => runtime.close().await.unwrap(),
        Err(_) => panic!("Fixture runtime ownership leaked"),
    }
    let handled = observed.unwrap();
    let result: HostResult =
        serde_json::from_slice(&std::fs::read(directory.path().join("reply.json")).unwrap())
            .unwrap();
    let completed = directory.path().join("finished").exists();
    assert!(
        matches!(result, HostResult::Process { exit_code: 0, .. }),
        "Ordinary reset cancelled work: {result:?}"
    );
    assert!(
        completed,
        "The disconnected client's admitted process did not finish"
    );
    assert!(handled.unwrap().is_ok());
}
