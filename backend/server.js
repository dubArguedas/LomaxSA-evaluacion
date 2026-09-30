require('dotenv').config();

const express = require('express');

const { Pool } = require('pg');

const multer = require('multer');

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');

const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');



const app = express();

app.use(express.json());



// Configuración PostgreSQL

const pool = new Pool({

  host: process.env.DB_HOST,

  port: parseInt(process.env.DB_PORT),

  database: process.env.DB_NAME,

  user: process.env.DB_USER,

  password: process.env.DB_PASSWORD,

});



// Configuración Clientes AWS (LocalStack / FLOCI)

const awsConfig = {

  endpoint: process.env.AWS_ENDPOINT_URL,

  region: process.env.AWS_REGION,

  forcePathStyle: true,

  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }

};



const s3 = new S3Client(awsConfig);

const ddbClient = new DynamoDBClient(awsConfig);

const docClient = DynamoDBDocumentClient.from(ddbClient);

const lambda = new LambdaClient(awsConfig);



// Configuración Multer (Límite 5MB)

const upload = multer({

  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB

  fileFilter: (req, file, cb) => {

    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {

      cb(null, true);

    } else {

      cb(new Error('FORMAT_NOT_ALLOWED'));

    }

  }

});



// -------------------------------------------------------------

// 1. GET /categorias (200: devuelve categorías almacenadas en RDS)

// -------------------------------------------------------------

app.get('/categorias', async (req, res) => {

  try {

    const result = await pool.query('SELECT categoria_id AS id, nombre FROM categorias ORDER BY categoria_id ASC');
    res.status(200).json(result.rows);
  } catch (err) {

    res.status(503).json({ error: 'Fallo de conexion con RDS', paso_fallido: 'RDS_CATEGORIAS_GET' });

  }

});



// -------------------------------------------------------------

// 2. POST /productos (201: PENDIENTE en RDS y DynamoDB)

// -------------------------------------------------------------
app.post('/productos', async (req, res) => {

  const { codigo, nombre, descripcion, precio, categoria_id } = req.body;



  // 1. Validar campos de entrada requeridos (400)

  if (!codigo || !nombre || precio === undefined || precio === null || Number(precio) < 0 || !categoria_id) {

    return res.status(400).json({

      error: 'Datos de producto invalidos',

      paso_fallido: 'VALIDACION_ENTRADA'

    });

  }



  try {

    // 2. Verificar si la categoría existe en la tabla "categorias"

    const catCheck = await pool.query(

      'SELECT categoria_id FROM categorias WHERE categoria_id = $1',

      [categoria_id]

    );

    if (catCheck.rows.length === 0) {

      return res.status(400).json({

        error: 'La categoria especificada no existe',

        paso_fallido: 'CATEGORIA_INEXISTENTE'

      });

    }



    // 3. Verificar si el código ya existe (409) - "productos_codigo_key"

    const codCheck = await pool.query(

      'SELECT codigo FROM productos WHERE codigo = $1',

      [codigo]

    );

    if (codCheck.rows.length > 0) {

      return res.status(409).json({

        error: 'El codigo de producto ya existe',

        paso_fallido: 'PRODUCTO_DUPLICADO'

      });

    }



    // 4. Insertar en RDS (estado 'PENDIENTE' permitido por productos_estado_check)

    const queryText = `

      INSERT INTO productos (codigo, nombre, descripcion, precio, categoria_id, estado)

      VALUES ($1, $2, $3, $4, $5, 'PENDIENTE')

      RETURNING producto_id, codigo, nombre, descripcion, precio, categoria_id, fecha_creacion, estado

    `;

    const values = [codigo, nombre, descripcion || null, precio, categoria_id];

    const result = await pool.query(queryText, values);



    // Mapeamos producto_id a "id" si tu frontend/evaluación lo requiere con ese nombre

    const productoCreado = {

      id: result.rows[0].producto_id,

      ...result.rows[0]

    };



    res.status(201).json(productoCreado);



  } catch (err) {

    console.error('Error al insertar producto:', err);

    res.status(502).json({

      error: 'Fallo al guardar en BD',

      detalle: err.message,

      paso_fallido: 'RDS_DYNAMO_POST_PRODUCTO'

    });

  }

});


// Helper de Invocación de Procesamiento de Imagen

async function procesarImagenProducto(productoId, fileBuffer, mimeType) {

  const extension = mimeType === 'image/jpeg' ? 'jpg' : 'png';

  const originalKey = `originales/producto_${productoId}.${extension}`;



  // 1. Guardar original en S3

  await s3.send(new PutObjectCommand({

    Bucket: process.env.S3_BUCKET_ORIGINALES,

    Key: originalKey,

    Body: fileBuffer,

    ContentType: mimeType

  }));



  // 2. Invocar Lambda síncronamente

  const lambdaPayload = JSON.stringify({

    producto_id: String(productoId),

    bucket: process.env.S3_BUCKET_ORIGINALES,

    key: originalKey

  });



  const lambdaRes = await lambda.send(new InvokeCommand({

    FunctionName: process.env.LAMBDA_FUNCTION_NAME,

    Payload: Buffer.from(lambdaPayload)

  }));



  const payloadString = new TextDecoder().decode(lambdaRes.Payload);

  const lambdaResult = JSON.parse(payloadString);



  if (lambdaResult.statusCode !== 200) {

    throw new Error(`Error en Lambda: ${lambdaResult.body}`);

  }



  // 3. Actualizar estado a PUBLICADO en RDS

  await pool.query('UPDATE productos SET estado = $1 WHERE id = $2', ['PUBLICADO', productoId]);



  return { originalKey, lambdaResult };

}



// -------------------------------------------------------------

// 3. POST /productos/{id}/imagen (Cargar imagen e invocar Lambda)

// -------------------------------------------------------------

app.post('/productos/:id/imagen', (req, res) => {

  upload.single('imagen')(req, res, async (err) => {

    if (err) {

      if (err.code === 'LIMIT_FILE_SIZE') {

        return res.status(413).json({ error: 'El archivo excede el limite de 5 Mb' });

      }

      if (err.message === 'FORMAT_NOT_ALLOWED') {

        return res.status(415).json({ error: 'Formato no permitido. Solo JPEG o PNG' });

      }

      return res.status(400).json({ error: err.message });

    }



    const productoId = req.params.id;

    if (!req.file) {

      return res.status(400).json({ error: 'Debe adjuntar una imagen' });

    }



    try {

      // Verificar existencia en RDS

      const prodCheck = await pool.query('SELECT id FROM productos WHERE id = $1', [productoId]);

      if (prodCheck.rowCount === 0) {

        return res.status(404).json({ error: 'Producto no encontrado' });

      }



      await procesarImagenProducto(productoId, req.file.buffer, req.file.mimetype);



      res.status(200).json({

        producto_id: parseInt(productoId),

        estado: 'PUBLICADO',

        mensaje: 'Imagen procesada y producto PUBLICADO'

      });



    } catch (error) {

      res.status(502).json({ error: 'Fallo en procesamiento de servicio dependiente', detalle: error.message, paso_fallido: 'INVOCACION_LAMBDA_S3' });

    }

  });

});



// -------------------------------------------------------------

// 4. POST /productos/{id}/reprocesar (Reintentar imagen)

// -------------------------------------------------------------

app.post('/productos/:id/reprocesar', async (req, res) => {

  const productoId = req.params.id;



  try {

    // 1. Obtener referencia del original en DynamoDB

    const dynamoRes = await docClient.send(new GetCommand({

      TableName: process.env.DYNAMODB_TABLE,

      Key: { producto_id: String(productoId) }

    }));



    if (!dynamoRes.Item || !dynamoRes.Item.imagen_original_key) {

      return res.status(409).json({ error: 'No existe una imagen original guardada para reprocesar' });

    }



    const originalKey = dynamoRes.Item.imagen_original_key;



    // 2. Invocar Lambda síncronamente

    const lambdaPayload = JSON.stringify({

      producto_id: String(productoId),

      bucket: process.env.S3_BUCKET_ORIGINALES,

      key: originalKey

    });



    const lambdaRes = await lambda.send(new InvokeCommand({

      FunctionName: process.env.LAMBDA_FUNCTION_NAME,

      Payload: Buffer.from(lambdaPayload)

    }));



    // 3. Actualizar RDS a PUBLICADO

    await pool.query('UPDATE productos SET estado = $1 WHERE id = $2', ['PUBLICADO', productoId]);



    res.status(200).json({

      producto_id: parseInt(productoId),

      estado: 'PUBLICADO',

      mensaje: 'Producto reprocesado exitosamente'

    });



  } catch (err) {

    res.status(502).json({ error: 'Fallo al reprocesar', detalle: err.message, paso_fallido: 'REPROCESO_LAMBDA' });

  }

});



// -------------------------------------------------------------

// 5. GET /productos (Combina RDS + DynamoDB, solo PUBLICADOS)

// -------------------------------------------------------------

app.get('/productos', async (req, res) => {

  try {

    const rdsResult = await pool.query("SELECT * FROM productos WHERE estado = 'PUBLICADO' ORDER BY id ASC");

    

    const productosCombinados = await Promise.all(

      rdsResult.rows.map(async (prod) => {

        const dynamoRes = await docClient.send(new GetCommand({

          TableName: process.env.DYNAMODB_TABLE,

          Key: { producto_id: String(prod.id) }

        }));



        return {

          ...prod,

          atributos: dynamoRes.Item?.atributos || {},

          miniatura_key: dynamoRes.Item?.miniatura_key || null

        };

      })

    );



    res.status(200).json(productosCombinados);

  } catch (err) {

    res.status(503).json({ error: 'Fallo al consultar productos', detalle: err.message, paso_fallido: 'GET_PRODUCTOS_COMBINADO' });

  }

});



// -------------------------------------------------------------

// 6. GET /productos/{id} (Detalle de cualquier estado: PENDIENTE/PUBLICADO)

// -------------------------------------------------------------

app.get('/productos/:id', async (req, res) => {

  const productoId = req.params.id;



  try {

    const rdsResult = await pool.query('SELECT * FROM productos WHERE id = $1', [productoId]);

    if (rdsResult.rowCount === 0) {

      return res.status(404).json({ error: 'Producto no encontrado' });

    }



    const prod = rdsResult.rows[0];



    const dynamoRes = await docClient.send(new GetCommand({

      TableName: process.env.DYNAMODB_TABLE,

      Key: { producto_id: String(productoId) }

    }));



    res.status(200).json({

      ...prod,

      atributos: dynamoRes.Item?.atributos || {},

      estado_procesamiento: dynamoRes.Item?.estado_procesamiento || 'DESCONOCIDO',

      miniatura_key: dynamoRes.Item?.miniatura_key || null,

      error_mensaje: dynamoRes.Item?.error_mensaje || null

    });



  } catch (err) {

    res.status(503).json({ error: 'Fallo al consultar producto', paso_fallido: 'GET_PRODUCTO_ID' });

  }

});



// -------------------------------------------------------------

// 7. GET /productos/{id}/imagen (Recupera bytes de miniatura en S3)

// -------------------------------------------------------------

app.get('/productos/:id/imagen', async (req, res) => {

  const productoId = req.params.id;



  try {

    const dynamoRes = await docClient.send(new GetCommand({

      TableName: process.env.DYNAMODB_TABLE,

      Key: { producto_id: String(productoId) }

    }));



    if (!dynamoRes.Item || !dynamoRes.Item.miniatura_key) {

      return res.status(404).json({ error: 'Miniatura no disponible' });

    }



    const s3Res = await s3.send(new GetObjectCommand({

      Bucket: process.env.S3_BUCKET_MINIATURES,

      Key: dynamoRes.Item.miniatura_key

    }));



    res.setHeader('Content-Type', s3Res.ContentType || 'image/png');

    s3Res.Body.pipe(res);



  } catch (err) {

    res.status(404).json({ error: 'Imagen no encontrada en S3', paso_fallido: 'GET_IMAGEN_S3' });

  }

});



const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(`Backend API ejecutandose en el puerto ${PORT}`);

});
