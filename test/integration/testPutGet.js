/*
 * Copyright (c) 2015-2021 Snowflake Computing Inc. All rights reserved.
 */

const assert = require('assert');
const async = require('async');
const connOption = require('./connectionOptions');
const fileCompressionType = require('./../../lib/file_transfer_agent/file_compression_type');
const fs = require('fs');
const testUtil = require('./testUtil');
const tmp = require('tmp');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const DATABASE_NAME = connOption.valid.database;
const SCHEMA_NAME = connOption.valid.schema;
const TEMP_TABLE_NAME = 'TEMP_TABLE';

const SKIPPED = "SKIPPED";
const UPLOADED = "UPLOADED";
const DOWNLOADED = "DOWNLOADED";

const COL1 = 'C1';
const COL2 = 'C2';
const COL3 = 'C3';
const COL1_DATA = 'FIRST';
const COL2_DATA = 'SECOND';
const COL3_DATA = 'THIRD';
const ROW_DATA =
  COL1_DATA + "," + COL2_DATA + "," + COL3_DATA + "\n" +
  COL1_DATA + "," + COL2_DATA + "," + COL3_DATA + "\n" +
  COL1_DATA + "," + COL2_DATA + "," + COL3_DATA + "\n" +
  COL1_DATA + "," + COL2_DATA + "," + COL3_DATA + "\n";
const ROW_DATA_SIZE = 76;

const ROW_DATA_OVERWRITE = COL3_DATA + "," + COL1_DATA + "," + COL2_DATA + "\n";
const ROW_DATA_OVERWRITE_SIZE = 19;

function getPlatformTmpPath(tmpPath){
  var path = `file://${tmpPath}`;
  // Windows user contains a '~' in the path which causes an error
  if (process.platform == "win32")
  {
    var fileName = tmpPath.substring(tmpPath.lastIndexOf('\\'));
    path = `file://${process.env.USERPROFILE}\\AppData\\Local\\Temp\\${fileName}`;
  }
  return path;
}

function executePutCmd(connection, putQuery, callback, results){
  // Upload file
  var statement = connection.execute({
    sqlText: putQuery,
    complete: function (err, stmt, rows)
    {
      var stream = statement.streamRows();
      stream.on('error', function (err)
      {
        callback(err);
      });
      stream.on('data', function (row)
      {
        results.fileSize = row.targetSize;
        // Check the file is correctly uploaded
        assert.strictEqual(row['status'], UPLOADED);
        // Check the target encoding is correct
        assert.strictEqual(row['targetCompression'], 'GZIP');
      });
      stream.on('end', function (row)
      {
        callback();
      });
    }
  });
}

describe('PUT GET test', function ()
{
  var connection;
  var tmpFile;
  var createTable = `create or replace table ${TEMP_TABLE_NAME} (${COL1} STRING, ${COL2} STRING, ${COL3} STRING)`;
  var copyInto = `COPY INTO ${TEMP_TABLE_NAME}`;
  var removeFile = `REMOVE @${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME}`;
  var dropTable = `DROP TABLE IF EXISTS ${TEMP_TABLE_NAME}`;

  before(function (done)
  {
    connection = testUtil.createConnection();
    testUtil.connect(connection, done);
  });

  after(function (done)
  {
    testUtil.destroyConnection(connection, done);
  });

  afterEach(function ()
  {
    fs.closeSync(tmpFile.fd);
    fs.unlinkSync(tmpFile.name);
  });

  var testCases =
    [
      {
        name: 'gzip',
        encoding: fileCompressionType.lookupByMimeSubType('gzip'),
      },
      {
        name: 'bzip2',
        encoding: fileCompressionType.lookupByMimeSubType('bz2'),
      },
      {
        name: 'brotli',
        encoding: fileCompressionType.lookupByMimeSubType('br'),
      },
      {
        name: 'deflate',
        encoding: fileCompressionType.lookupByMimeSubType('deflate'),
      },
      {
        name: 'raw deflate',
        encoding: fileCompressionType.lookupByMimeSubType('raw_deflate'),
      },
      {
        name: 'zstd',
        encoding: fileCompressionType.lookupByMimeSubType('zstd'),
      }
    ];

  var createItCallback = function (testCase)
  {
    return function (done)
    {
      {
        // Create a temp file with specified file extension
        tmpFile = tmp.fileSync({ postfix: testCase.encoding['file_extension'] });
        // Write row data to temp file
        fs.writeFileSync(tmpFile.name, ROW_DATA);

        var putQuery = `PUT file://${tmpFile.name} @${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME}`;
        // Windows user contains a '~' in the path which causes an error
        if (process.platform == "win32")
        {
          var fileName = tmpFile.name.substring(tmpFile.name.lastIndexOf('\\'));
          putQuery = `PUT file://${process.env.USERPROFILE}\\AppData\\Local\\Temp\\${fileName} @${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME}`;
        }

        // Create a tmp folder for downloaded files
        var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get'));
        var fileSize;

        var getQuery = `GET @${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME} file://${tmpDir}`;
        // Windows user contains a '~' in the path which causes an error
        if (process.platform == "win32")
        {
          var dirName = tmpDir.substring(tmpDir.lastIndexOf('\\') + 1);
          getQuery = `GET @${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME} file://${process.env.USERPROFILE}\\AppData\\Local\\Temp\\${dirName}`;
        }

        async.series(
          [
            function (callback)
            {
              // Create temp table
              testUtil.executeCmd(connection, createTable, callback);
            },
            function (callback)
            {
              // Upload file
              var statement = connection.execute({
                sqlText: putQuery,
                complete: function (err, stmt, rows)
                {
                  var stream = statement.streamRows();
                  stream.on('error', function (err)
                  {
                    done(err);
                  });
                  stream.on('data', function (row)
                  {
                    fileSize = row.targetSize;
                    // Check the file is correctly uploaded
                    assert.strictEqual(row['status'], UPLOADED);
                    // Check the target encoding is correct
                    assert.strictEqual(row['targetCompression'], testCase.encoding['name']);
                  });
                  stream.on('end', function (row)
                  {
                    callback();
                  });
                }
              });
            },
            function (callback)
            {
              // Copy into temp table
              testUtil.executeCmd(connection, copyInto, callback);
            },
            function (callback)
            {
              // Check the contents are correct
              var statement = connection.execute({
                sqlText: `SELECT * FROM ${TEMP_TABLE_NAME}`,
                complete: function (err, stmt, rows)
                {
                  var stream = statement.streamRows();
                  stream.on('error', function (err)
                  {
                    done(err);
                  });
                  stream.on('data', function (row)
                  {
                    // Check the row data is correct
                    assert.strictEqual(row[COL1], COL1_DATA);
                    assert.strictEqual(row[COL2], COL2_DATA);
                    assert.strictEqual(row[COL3], COL3_DATA);
                  });
                  stream.on('end', function (row)
                  {
                    callback()
                  });
                }
              });
            },
            function (callback)
            {
              // Check the row count is correct
              var statement = connection.execute({
                sqlText: `SELECT COUNT(*) FROM ${TEMP_TABLE_NAME}`,
                complete: function (err, stmt, rows)
                {
                  var stream = statement.streamRows();
                  stream.on('error', function (err)
                  {
                    done(err);
                  });
                  stream.on('data', function (row)
                  {
                    // Check the row count is correct
                    assert.strictEqual(row['COUNT(*)'], 4);
                  });
                  stream.on('end', function (row)
                  {
                    callback();
                  });
                }
              });
            },
            function (callback)
            {
              // Run GET command
              var statement = connection.execute({
                sqlText: getQuery,
                complete: function (err, stmt, rows)
                {
                  var stream = statement.streamRows();
                  stream.on('error', function (err)
                  {
                    done(err);
                  });
                  stream.on('data', function (row)
                  {
                    assert.strictEqual(row.status, DOWNLOADED);
                    assert.strictEqual(row.size, fileSize);
                    // Delete the downloaded file
                    fs.unlink(path.join(tmpDir, row.file), (err) =>
                    {
                      if (err) throw (err);
                      // Delete the temporary folder
                      fs.rmdir(tmpDir, (err) =>
                      {
                        if (err) throw (err);
                      });
                    });
                  });
                  stream.on('end', function (row)
                  {
                    callback();
                  });
                }
              });
            },
            function (callback)
            {
              // Remove files from staging
              testUtil.executeCmd(connection, removeFile, callback);
            },
            function (callback)
            {
              // Drop temp table
              testUtil.executeCmd(connection, dropTable, callback);
            }
          ],
          done
        );
      };
    };
  };

  for (var index = 0; index < testCases.length; index++)
  {
    var testCase = testCases[index];
    it(testCase.name, createItCallback(testCase));
  }
});

describe('PUT GET overwrite test', function ()
{
  var connection;
  var tmpFile;
  var createTable = `create or replace table ${TEMP_TABLE_NAME} (${COL1} STRING, ${COL2} STRING, ${COL3} STRING)`;
  var removeFile = `REMOVE @${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME}`;
  var dropTable = `DROP TABLE IF EXISTS ${TEMP_TABLE_NAME}`;

  // Create a temp file with specified file extension
  var tmpFile = tmp.fileSync();
  // Write row data to temp file
  fs.writeFileSync(tmpFile.name, ROW_DATA);

  before(function (done)
  {
    connection = testUtil.createConnection();
    testUtil.connect(connection, done);
  });

  after(function (done)
  {
    testUtil.destroyConnection(connection, done);
  });

  var putQuery = `
    PUT file://${tmpFile.name} @${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME} AUTO_COMPRESS=FALSE`;
  // Windows user contains a '~' in the path which causes an error
  if (process.platform == "win32")
  {
    var fileName = tmpFile.name.substring(tmpFile.name.lastIndexOf('\\'));
    putQuery = `
      PUT file://${process.env.USERPROFILE}\\AppData\\Local\\Temp\\${fileName} @${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME} AUTO_COMPRESS=FALSE`;
  }

  var testCases =
    [
      {
        name: 'overwrite'
      },
    ];

  var createItCallback = function (testCase)
  {
    return function (done)
    {
      {
        async.series(
          [
            function (callback)
            {
              // Create temp table
              testUtil.executeCmd(connection, createTable, callback);
            },
            function (callback)
            {
              var statement = connection.execute({
                sqlText: putQuery,
                complete: function (err, stmt, rows)
                {
                  var stream = statement.streamRows();
                  stream.on('error', function (err)
                  {
                    done(err);
                  });
                  stream.on('data', function (row)
                  {
                    // Check the file is correctly uploaded
                    assert.strictEqual(row['status'], UPLOADED);
                    assert.strictEqual(row.targetSize, ROW_DATA_SIZE);
                  });
                  stream.on('end', function (row)
                  {
                    callback();
                  });
                }
              });
            },
            function (callback)
            {
              var statement = connection.execute({
                sqlText: putQuery,
                complete: function (err, stmt, rows)
                {
                  var stream = statement.streamRows();
                  stream.on('error', function (err)
                  {
                    done(err);
                  });
                  stream.on('data', function (row)
                  {
                    if (!connOption.account.includes("gcp"))
                    {
                      // Check the file is correctly uploaded
                      assert.strictEqual(row['status'], SKIPPED);
                    }
                  });
                  stream.on('end', function (row)
                  {
                    callback();
                  });
                }
              });
            },
            function (callback)
            {
              fs.writeFileSync(tmpFile.name, ROW_DATA_OVERWRITE);
              putQuery += " OVERWRITE=TRUE";

              var statement = connection.execute({
                sqlText: putQuery,
                complete: function (err, stmt, rows)
                {
                  var stream = statement.streamRows();
                  stream.on('error', function (err)
                  {
                    done(err);
                  });
                  stream.on('data', function (row)
                  {
                    // Check the file is correctly uploaded
                    assert.strictEqual(row['status'], UPLOADED);
                    assert.strictEqual(row.targetSize, ROW_DATA_OVERWRITE_SIZE);
                  });
                  stream.on('end', function (row)
                  {
                    callback();
                  });
                }
              });
            },
            function (callback)
            {
              fs.closeSync(tmpFile.fd);
              fs.unlinkSync(tmpFile.name);

              // Remove files from staging
              testUtil.executeCmd(connection, removeFile, callback);
            },
            function (callback)
            {
              // Drop temp table
              testUtil.executeCmd(connection, dropTable, callback);
            }
          ],
          done
        );
      };
    };
  };

  for (var index = 0; index < testCases.length; index++)
  {
    var testCase = testCases[index];
    it(testCase.name, createItCallback(testCase));
  }
});

describe('PUT GET test with GCS_USE_DOWNSCOPED_CREDENTIAL', function ()
{
  var connection;

  before(function (done)
  {
    connection = testUtil.createConnection();
    connection.gcsUseDownscopedCredential = true;
    testUtil.connect(connection, done);
  });

  after(function (done)
  {
    testUtil.destroyConnection(connection, done);
  });

  it('testSelectLargeQuery', function (done)
  {
    async.series(
      [
        function (callback)
        {
          var rowCount = 100000;
          // Check the row count is correct
          var statement = connection.execute({
            sqlText: `SELECT COUNT(*) FROM (select seq4() from table(generator(rowcount => ${rowCount})))`,
            complete: function (err, stmt, rows)
            {
              var stream = statement.streamRows();
              stream.on('error', function (err)
              {
                done(err);
              });
              stream.on('data', function (row)
              {
                // Check the row count is correct
                assert.strictEqual(row['COUNT(*)'], rowCount);
              });
              stream.on('end', function (row)
              {
                callback();
              });
            }
          });
        }
      ],
      done
    );
  });

  it('testUploadDownload', function (done)
  {
    var tmpFile;
    var createTable = `create or replace table ${TEMP_TABLE_NAME} (${COL1} STRING, ${COL2} STRING, ${COL3} STRING)`;
    var copyInto = `COPY INTO ${TEMP_TABLE_NAME}`;
    var removeFile = `REMOVE @${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME}`;
    var dropTable = `DROP TABLE IF EXISTS ${TEMP_TABLE_NAME}`;

    // Create a temp file with specified file extension
    tmpFile = tmp.fileSync({ postfix: 'gz' });
    // Write row data to temp file
    fs.writeFileSync(tmpFile.name, ROW_DATA);

    var putQuery = `PUT file://${tmpFile.name} @${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME}`;
    // Windows user contains a '~' in the path which causes an error
    if (process.platform == "win32")
    {
      var fileName = tmpFile.name.substring(tmpFile.name.lastIndexOf('\\'));
      putQuery = `PUT file://${process.env.USERPROFILE}\\AppData\\Local\\Temp\\${fileName} @${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME}`;
    }

    // Create a tmp folder for downloaded files
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get'));
    var fileSize;

    var getQuery = `GET @${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME} file://${tmpDir}`;
    // Windows user contains a '~' in the path which causes an error
    if (process.platform == "win32")
    {
      var dirName = tmpDir.substring(tmpDir.lastIndexOf('\\') + 1);
      getQuery = `GET @${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME} file://${process.env.USERPROFILE}\\AppData\\Local\\Temp\\${dirName}`;
    }

    async.series(
      [
        function (callback)
        {
          // Create temp table
          testUtil.executeCmd(connection, createTable, callback);
        },
        function (callback)
        {
          // Upload file
          var statement = connection.execute({
            sqlText: putQuery,
            complete: function (err, stmt, rows)
            {
              var stream = statement.streamRows();
              stream.on('error', function (err)
              {
                done(err);
              });
              stream.on('data', function (row)
              {
                fileSize = row.targetSize;
                // Check the file is correctly uploaded
                assert.strictEqual(row['status'], UPLOADED);
                // Check the target encoding is correct
                assert.strictEqual(row['targetCompression'], 'GZIP');
              });
              stream.on('end', function (row)
              {
                callback();
              });
            }
          });
        },
        function (callback)
        {
          // Copy into temp table
          testUtil.executeCmd(connection, copyInto, callback);
        },
        function (callback)
        {
          // Check the contents are correct
          var statement = connection.execute({
            sqlText: `SELECT * FROM ${TEMP_TABLE_NAME}`,
            complete: function (err, stmt, rows)
            {
              var stream = statement.streamRows();
              stream.on('error', function (err)
              {
                done(err);
              });
              stream.on('data', function (row)
              {
                // Check the row data is correct
                assert.strictEqual(row[COL1], COL1_DATA);
                assert.strictEqual(row[COL2], COL2_DATA);
                assert.strictEqual(row[COL3], COL3_DATA);
              });
              stream.on('end', function (row)
              {
                callback()
              });
            }
          });
        },
        function (callback)
        {
          // Check the row count is correct
          var statement = connection.execute({
            sqlText: `SELECT COUNT(*) FROM ${TEMP_TABLE_NAME}`,
            complete: function (err, stmt, rows)
            {
              var stream = statement.streamRows();
              stream.on('error', function (err)
              {
                done(err);
              });
              stream.on('data', function (row)
              {
                // Check the row count is correct
                assert.strictEqual(row['COUNT(*)'], 4);
              });
              stream.on('end', function (row)
              {
                callback();
              });
            }
          });
        },
        function (callback)
        {
          // Run GET command
          var statement = connection.execute({
            sqlText: getQuery,
            complete: function (err, stmt, rows)
            {
              var stream = statement.streamRows();
              stream.on('error', function (err)
              {
                done(err);
              });
              stream.on('data', function (row)
              {
                assert.strictEqual(row.status, DOWNLOADED);
                assert.strictEqual(row.size, fileSize);
                // Delete the downloaded file
                fs.unlink(path.join(tmpDir, row.file), (err) =>
                {
                  if (err) throw (err);
                  // Delete the temporary folder
                  fs.rmdir(tmpDir, (err) =>
                  {
                    if (err) throw (err);
                  });
                });
              });
              stream.on('end', function (row)
              {
                callback();
              });
            }
          });
        },
        function (callback)
        {
          // Remove files from staging
          testUtil.executeCmd(connection, removeFile, callback);
        },
        function (callback)
        {
          // Drop temp table
          testUtil.executeCmd(connection, dropTable, callback);
        },
        function (callback)
        {
          fs.closeSync(tmpFile.fd);
          fs.unlinkSync(tmpFile.name);
          callback();
        }
      ],
      done
    );
  });
});

describe('PUT GET test multiple files', function ()
{
  var connection;
  var stage = `@${DATABASE_NAME}.${SCHEMA_NAME}.%${TEMP_TABLE_NAME}`;
  var removeFile = `REMOVE ${stage}`;

  before(function (done)
  {
    connection = testUtil.createConnection();
    connection.gcsUseDownscopedCredential = true;
    async.series(
      [
        function (callback)
        {
          testUtil.connect(connection, callback);
        },
        function (callback)
        {
          var createTable = `create or replace table ${TEMP_TABLE_NAME} (${COL1} STRING, ${COL2} STRING, ${COL3} STRING)`;
          // Create temp table
          testUtil.executeCmd(connection, createTable, callback);
        }
      ],
      done
    );
  });

  after(function (done)
  { 
    async.series(
      [
        function (callback)
        {
          var dropTable = `DROP TABLE IF EXISTS ${TEMP_TABLE_NAME}`;
          // Drop temp table
          testUtil.executeCmd(connection, dropTable, callback);
        },
        function (callback)
        {
          testUtil.destroyConnection(connection, callback);
        }
      ],
      done
    );
  });

  it('testDownloadMultifiles', function (done)
  {
    var tmpFile1, tmpFile2;

    // Create two temp file with specified file extension
    tmpFile1 = tmp.fileSync({ postfix: 'gz' });
    tmpFile2 = tmp.fileSync({ postfix: 'gz' });
    // Write row data to temp file
    fs.writeFileSync(tmpFile1.name, ROW_DATA);
    fs.writeFileSync(tmpFile2.name, ROW_DATA);

    var tmpfilePath1 = getPlatformTmpPath(tmpFile1.name);
    var tmpfilePath2 = getPlatformTmpPath(tmpFile2.name);

    var putQuery1 = `PUT ${tmpfilePath1} ${stage}`;
    var putQuery2 = `PUT ${tmpfilePath2} ${stage}`;

    // Create a tmp folder for downloaded files
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get'));
    var results = {};
 
    var tmpdirPath = getPlatformTmpPath(tmpDir);
    var getQuery = `GET ${stage} ${tmpdirPath}`;

    async.series(
      [
        function (callback)
        {
          fileSize = executePutCmd(connection, putQuery1, callback, results);
        },
        function (callback)
        {
          fileSize = executePutCmd(connection, putQuery2, callback, results);
        },
        function (callback)
        {
          // Run GET command
          var statement = connection.execute({
            sqlText: getQuery,
            complete: function (err, stmt, rows)
            {
              var stream = statement.streamRows();
              stream.on('error', function (err)
              {
                callback(err);
              });
              stream.on('data', function (row)
              {
                assert.strictEqual(row.status, DOWNLOADED);
                assert.strictEqual(row.size, results.fileSize);

                // Decompress the downloaded file
                var compressedFile = path.join(tmpDir,row.file);
                var decompressedFile = path.join(tmpDir,'de-'+row.file);
                const fileContents = fs.createReadStream(compressedFile);
                const writeStream = fs.createWriteStream(decompressedFile);
                const unzip = zlib.createGunzip();

                fileContents.pipe(unzip).pipe(writeStream).on('finish', function() {
                  // Verify the data of the downloaded file
                  var data = fs.readFileSync(decompressedFile).toString();
                  assert.strictEqual(data, ROW_DATA);
                  fs.unlinkSync(compressedFile);
                  fs.unlinkSync(decompressedFile);
                })
              });
              stream.on('end', function (row)
              {
                callback();
              });
            }
          });
        },
        function (callback)
        {
          // Remove files from staging
          testUtil.executeCmd(connection, removeFile, callback);
        },
        function (callback)
        {       
          fs.closeSync(tmpFile1.fd);
          fs.unlinkSync(tmpFile1.name);
          fs.closeSync(tmpFile2.fd);
          fs.unlinkSync(tmpFile2.name);

          // Delete the temporary folder
          fs.rmdir(tmpDir, (err) =>
          {
            if (err) throw (err);
          });
          callback();
        }
      ],
      done
    );
  });

  it('testUploadMultifiles', function (done)
  {
    const count = 5;
    var tmpFiles = [];

    // Create a tmp folder for downloaded files
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get'));
    var results = {};

    var tmpdirPath = getPlatformTmpPath(tmpDir);
    var getQuery = `GET ${stage} ${tmpdirPath}`;

    // Create temp files with specified prefix
    for (let i = 0; i < count; i++) {
      var tmpFile = tmp.fileSync({ prefix: 'testUploadDownloadMultifiles'});
      fs.writeFileSync(tmpFile.name, ROW_DATA);
      tmpFiles.push(tmpFile);
    }

    var putQuery = `PUT file://${os.tmpdir()}/testUploadDownloadMultifiles* ${stage}`;
    // Windows user contains a '~' in the path which causes an error
    if (process.platform == "win32")
    {
      putQuery = `PUT file://${process.env.USERPROFILE}\\AppData\\Local\\Temp\\testUploadDownloadMultifiles* ${stage}`;
    }

    async.series(
      [
        function (callback)
        {
          fileSize = executePutCmd(connection, putQuery, callback, results);
        },
        function (callback)
        {
          // Run GET command
          var statement = connection.execute({
            sqlText: getQuery,
            complete: function (err, stmt, rows)
            {
              var stream = statement.streamRows();
              stream.on('error', function (err)
              {
                callback(err);
              });
              stream.on('data', function (row)
              {
                assert.strictEqual(row.status, DOWNLOADED);
                assert.strictEqual(row.size, results.fileSize);

                // Decompress the downloaded file
                var compressedFile = path.join(tmpDir,row.file);
                var decompressedFile = path.join(tmpDir,'de-'+row.file);
                const fileContents = fs.createReadStream(compressedFile);
                const writeStream = fs.createWriteStream(decompressedFile);
                const unzip = zlib.createGunzip();

                fileContents.pipe(unzip).pipe(writeStream).on('finish', function() {
                  // Verify the data of the downloaded file
                  var data = fs.readFileSync(decompressedFile).toString();
                  assert.strictEqual(data, ROW_DATA);
                  fs.unlinkSync(compressedFile);
                  fs.unlinkSync(decompressedFile);
                }) 
              });
              stream.on('end', function (row)
              {
                callback();
              });
            }
          });
        },
        function (callback)
        {
          // Remove files from staging
          testUtil.executeCmd(connection, removeFile, callback);
        },
        function (callback)
        {
          for (let i = 0; i < count; i++) {
            fs.closeSync(tmpFiles[i].fd);
            fs.unlinkSync(tmpFiles[i].name);
          }
          // Delete the temporary folder
          fs.rmdir(tmpDir, (err) =>
          {
            if (err) throw (err);
          });
          callback();
        }
      ],
      done
    );
  });
});
